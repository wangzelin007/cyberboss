#!/usr/bin/env node
// One-shot migration helper for ~/.cyberboss/reminder-queue.json
//
// - Default mode is dry-run: prints the proposed reclassification table and exits.
// - Use --apply to actually rewrite the file (the original is automatically
//   backed up the first time the new code loads it; this script also writes a
//   .pre-migrate.json sibling before mutating, just to be safe).
// - Idempotent: if every entry already has a `kind` field, exits with "no
//   migration needed".
//
// Heuristic: scans Chinese / English keywords in `text` to suggest a `kind`
// and a default `periodMs`. Anything ambiguous is left as `temp` (the safe
// default — temp reminders persist until ack, so the worst case is the user
// must convert one to recurring later).

const fs = require("fs");
const os = require("os");
const path = require("path");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

const RULES = [
  { pattern: /每\s*小\s*时|每\s*[一二两三四五六七八九十\d]+\s*小时|hourly|each hour|every hour/i, periodMs: HOUR_MS, label: "1h" },
  { pattern: /每\s*周|每\s*星\s*期|weekly|each week|every week/i, periodMs: WEEK_MS, label: "1w" },
  { pattern: /每\s*月|monthly|each month|every month/i, periodMs: 30 * DAY_MS, label: "30d (approx month)" },
  { pattern: /每\s*天|每\s*日|每天提醒|每日提醒|daily|each day|every day/i, periodMs: DAY_MS, label: "1d" },
  { pattern: /定\s*期|周期|recurring|repeat/i, periodMs: 0, label: "?" }, // user must pick
];

function classify(text) {
  const body = String(text || "");
  for (const rule of RULES) {
    if (rule.pattern.test(body)) {
      return { kind: "recurring", periodMs: rule.periodMs, label: rule.label };
    }
  }
  return { kind: "temp", periodMs: 0, label: "" };
}

function defaultFilePath() {
  if (process.env.CYBERBOSS_STATE_DIR) {
    return path.join(process.env.CYBERBOSS_STATE_DIR, "reminder-queue.json");
  }
  return path.join(os.homedir(), ".cyberboss", "reminder-queue.json");
}

function parseArgs(argv) {
  const args = { apply: false, file: defaultFilePath() };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--file" && argv[i + 1]) {
      args.file = argv[++i];
    } else if (arg === "-h" || arg === "--help") {
      args.help = true;
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: scripts/migrate-reminders.js [--file PATH] [--apply]

Default file: ~/.cyberboss/reminder-queue.json

Without --apply, prints proposed reclassification only. With --apply, writes the
classified entries back to the file (and saves a .pre-migrate.json copy first).
Entries lacking a 'kind' field default to 'temp'; entries whose text contains
recurring keywords (每天 / 每周 / 每小时 / daily / weekly / hourly / 定期 / 周期 /
recurring) are flagged as 'recurring' with a suggested period.`);
}

function truncate(text, max = 50) {
  const oneLine = String(text || "").replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  let raw;
  try {
    raw = fs.readFileSync(args.file, "utf8");
  } catch (error) {
    console.error(`Cannot read ${args.file}: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(`Cannot parse ${args.file}: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const reminders = Array.isArray(parsed?.reminders) ? parsed.reminders : [];
  if (!reminders.length) {
    console.log("No reminders in file. Nothing to migrate.");
    return;
  }

  const allHaveKind = reminders.every((entry) => entry && typeof entry === "object" && entry.kind);
  if (allHaveKind) {
    console.log("All entries already have a 'kind' field. No migration needed.");
    return;
  }

  console.log(`Loaded ${reminders.length} reminder(s) from ${args.file}\n`);
  console.log("id (8)   | current   | suggested  | period      | text");
  console.log("---------+-----------+------------+-------------+--------------------------------------------------");

  const proposed = reminders.map((entry) => {
    const id8 = String(entry?.id || "").slice(0, 8);
    const current = entry?.kind || "temp";
    const suggestion = entry?.kind ? { kind: entry.kind, periodMs: entry.periodMs || 0, label: entry.periodMs ? `${entry.periodMs}ms` : "" } : classify(entry?.text);
    const periodLabel = suggestion.periodMs ? suggestion.label : (suggestion.kind === "recurring" ? "?" : "-");
    console.log(`${id8} | ${current.padEnd(9)} | ${suggestion.kind.padEnd(10)} | ${String(periodLabel).padEnd(11)} | ${truncate(entry?.text)}`);
    return { entry, suggestion };
  });

  const ambiguous = proposed.filter(({ suggestion }) => suggestion.kind === "recurring" && !suggestion.periodMs);
  if (ambiguous.length) {
    console.log(`\n⚠️  ${ambiguous.length} entr${ambiguous.length === 1 ? "y" : "ies"} flagged 'recurring' but the period is ambiguous (no exact daily/weekly/hourly match). These will keep periodMs unset; please edit the file manually after migration to set the right period before they can fire.`);
  }

  if (!args.apply) {
    console.log("\nDry-run. Re-run with --apply to write the changes.");
    return;
  }

  const preMigrationPath = `${args.file}.pre-migrate.json`;
  fs.writeFileSync(preMigrationPath, raw);
  console.log(`\nWrote pre-migration snapshot to ${preMigrationPath}`);

  const migrated = proposed.map(({ entry, suggestion }) => {
    if (entry?.kind) return entry;
    const next = { ...entry, kind: suggestion.kind };
    if (suggestion.kind === "recurring" && suggestion.periodMs) {
      next.periodMs = suggestion.periodMs;
    }
    return next;
  });

  const out = { ...parsed, reminders: migrated };
  fs.writeFileSync(args.file, JSON.stringify(out, null, 2));
  console.log(`Wrote migrated file to ${args.file}`);
  if (ambiguous.length) {
    console.log(`Remember: ${ambiguous.length} ambiguous recurring entr${ambiguous.length === 1 ? "y" : "ies"} still need a manual periodMs.`);
  }
}

main();
