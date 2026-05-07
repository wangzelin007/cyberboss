const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { ReminderQueueStore } = require("../src/adapters/channel/weixin/reminder-queue-store");
const { computeNextRecurringDueAtMs } = require("../src/services/reminder-schedule");

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-reminder-test-"));
  return path.join(dir, "reminder-queue.json");
}

function buildBaseFields(overrides = {}) {
  return {
    id: "rem-1",
    accountId: "acct-1",
    senderId: "user-1",
    contextToken: "tok-1",
    text: "do the thing",
    dueAtMs: Date.now() - 1000,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

test("legacy entries without `kind` load as temp and trigger backup", () => {
  const filePath = tmpFile();
  const legacy = {
    reminders: [
      {
        id: "legacy-1",
        accountId: "acct-x",
        senderId: "user-x",
        contextToken: "tok-x",
        text: "old reminder",
        dueAtMs: Date.now() - 60_000,
        createdAt: "2026-04-01T10:00:00.000Z",
      },
    ],
  };
  fs.writeFileSync(filePath, JSON.stringify(legacy));

  const store = new ReminderQueueStore({ filePath });
  assert.equal(store.state.reminders.length, 1);
  assert.equal(store.state.reminders[0].kind, "temp");

  const dir = path.dirname(filePath);
  const backups = fs.readdirSync(dir).filter((name) => name.startsWith("reminder-queue.backup-"));
  assert.equal(backups.length, 1, "expected exactly one backup file");
});

test("listDue skips temp reminders that have already fired (pending ack)", () => {
  const filePath = tmpFile();
  const store = new ReminderQueueStore({ filePath });
  store.enqueue(buildBaseFields({ id: "fresh", dueAtMs: Date.now() - 1000 }));
  store.enqueue(buildBaseFields({ id: "fired", dueAtMs: Date.now() - 1000, lastFiredAt: new Date().toISOString() }));

  const due = store.listDue(Date.now());
  const ids = due.map((entry) => entry.id);
  assert.deepEqual(ids, ["fresh"]);
});

test("ack and delete are idempotent and remove the entry", () => {
  const filePath = tmpFile();
  const store = new ReminderQueueStore({ filePath });
  store.enqueue(buildBaseFields({ id: "to-ack" }));

  const removed = store.acknowledge("to-ack");
  assert.equal(removed?.id, "to-ack");
  assert.equal(store.state.reminders.length, 0);

  // Second ack on the same id is a no-op, not an error.
  const second = store.acknowledge("to-ack");
  assert.equal(second, null);
  assert.equal(store.remove("never-existed"), null);
});

test("recurring next dueAt advances by periodMs and catches up past backlog", () => {
  const periodMs = 60 * 60 * 1000; // 1 hour
  const reminder = { dueAtMs: 1_000_000, periodMs, kind: "recurring" };
  const now = 1_000_000 + 4 * periodMs + 5_000;
  const next = computeNextRecurringDueAtMs(reminder, now, "UTC");
  // Catches up past 4 missed periods; next must be > now and aligned to original cadence.
  assert.ok(next > now);
  assert.equal((next - reminder.dueAtMs) % periodMs, 0);
});

test("recurring with activeWeekdays skips fires that land outside the allowed weekdays", () => {
  // 2026-05-09 is a Saturday in UTC. Period 1 day; allow Mon-Fri only.
  const baseDue = Date.UTC(2026, 4, 9, 9, 0, 0); // Sat 09:00 UTC
  const periodMs = 24 * 60 * 60 * 1000;
  const reminder = {
    dueAtMs: baseDue,
    periodMs,
    kind: "recurring",
    activeWeekdays: [1, 2, 3, 4, 5],
  };
  const now = baseDue + 1000;
  const next = computeNextRecurringDueAtMs(reminder, now, "UTC");
  // Sat -> Sun (skip) -> Mon (allowed)
  const nextDate = new Date(next);
  assert.equal(nextDate.getUTCDay(), 1, "expected next fire on Monday");
});

test("recurring with activeHours skips fires outside the local hour window", () => {
  // 22:00 + 1h step until we hit 09:00 the next day.
  const baseDue = Date.UTC(2026, 4, 5, 21, 0, 0); // 21:00 UTC, Tuesday
  const periodMs = 60 * 60 * 1000;
  const reminder = {
    dueAtMs: baseDue,
    periodMs,
    kind: "recurring",
    activeHours: "09:00-22:00",
  };
  const now = baseDue + 1000;
  const next = computeNextRecurringDueAtMs(reminder, now, "UTC");
  const nextDate = new Date(next);
  assert.equal(nextDate.getUTCHours(), 9);
});

test("normalizeReminder rejects recurring entries without a valid periodMs", () => {
  const filePath = tmpFile();
  const store = new ReminderQueueStore({ filePath });
  assert.throws(() => store.enqueue(buildBaseFields({ kind: "recurring" })), /invalid reminder/);
  assert.throws(() => store.enqueue(buildBaseFields({ kind: "recurring", periodMs: -1 })), /invalid reminder/);
});

test("listPendingTemp returns only temp reminders that have already fired", () => {
  const filePath = tmpFile();
  const store = new ReminderQueueStore({ filePath });
  store.enqueue(buildBaseFields({ id: "pending", lastFiredAt: new Date().toISOString() }));
  store.enqueue(buildBaseFields({ id: "fresh-temp" }));
  store.enqueue(buildBaseFields({ id: "recurring-1", kind: "recurring", periodMs: 3_600_000, lastFiredAt: new Date().toISOString() }));

  const pending = store.listPendingTemp({ accountId: "acct-1" });
  assert.deepEqual(pending.map((p) => p.id), ["pending"]);
});

test("update merges partial changes and preserves invariants", () => {
  const filePath = tmpFile();
  const store = new ReminderQueueStore({ filePath });
  store.enqueue(buildBaseFields({ id: "u1" }));
  const fired = new Date().toISOString();
  const updated = store.update("u1", { lastFiredAt: fired });
  assert.equal(updated.lastFiredAt, fired);
  assert.equal(store.state.reminders[0].lastFiredAt, fired);
  // Unknown id: no-op.
  assert.equal(store.update("nope", { lastFiredAt: fired }), null);
});

test("normalizeReminder defaults invalid activeHours to empty string (not stored)", () => {
  const filePath = tmpFile();
  const store = new ReminderQueueStore({ filePath });
  const entry = store.enqueue(buildBaseFields({
    id: "rec-bad-hours",
    kind: "recurring",
    periodMs: 3_600_000,
    activeHours: "not-a-range",
  }));
  assert.equal(entry.activeHours, undefined);
});

const { ReminderDoneStore } = require("../src/adapters/channel/weixin/reminder-done-store");

test("ReminderDoneStore.archive appends with closure metadata", () => {
  const filePath = tmpFile();
  const store = new ReminderDoneStore({ filePath });
  const entry = {
    id: "rem-1",
    accountId: "acct-1",
    senderId: "user-1",
    text: "buy milk",
    kind: "temp",
    dueAtMs: 123,
    createdAt: "2026-05-08T07:00:00.000Z",
    lastFiredAt: "2026-05-08T07:30:00.000Z",
  };
  const archived = store.archive(entry, { closeReason: "ack", closedBy: "user", closedAt: "2026-05-08T08:00:00.000Z" });
  assert.equal(archived.closeReason, "ack");
  assert.equal(archived.closedBy, "user");
  assert.equal(archived.closedAt, "2026-05-08T08:00:00.000Z");
  assert.equal(archived.text, "buy milk");

  // Roundtrip on disk and listClosedSince filter
  const reloaded = new ReminderDoneStore({ filePath });
  assert.equal(reloaded.state.reminders.length, 1);
  const recent = reloaded.listClosedSince(Date.parse("2026-05-08T07:30:00.000Z"), { accountId: "acct-1" });
  assert.equal(recent.length, 1);
  const tooEarly = reloaded.listClosedSince(Date.parse("2026-05-08T09:00:00.000Z"), { accountId: "acct-1" });
  assert.equal(tooEarly.length, 0);
});

test("ReminderDoneStore.archive rejects invalid closeReason and normalises closedBy", () => {
  const filePath = tmpFile();
  const store = new ReminderDoneStore({ filePath });
  const entry = { id: "x", accountId: "a", senderId: "s", text: "t", kind: "temp", dueAtMs: 1, createdAt: "" };
  assert.throws(() => store.archive(entry, { closeReason: "bogus" }), /invalid closeReason/);
  const out = store.archive(entry, { closeReason: "ack", closedBy: "hacker" });
  assert.equal(out.closedBy, "ai", "unknown closedBy falls back to 'ai' default");
});
