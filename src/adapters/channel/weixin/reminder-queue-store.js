const fs = require("fs");
const path = require("path");

const REMINDER_KIND_TEMP = "temp";
const REMINDER_KIND_RECURRING = "recurring";
const VALID_KINDS = new Set([REMINDER_KIND_TEMP, REMINDER_KIND_RECURRING]);

class ReminderQueueStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = { reminders: [] };
    this.ensureParentDirectory();
    this.load();
  }

  ensureParentDirectory() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  load() {
    let parsed = null;
    let raw = "";
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
      parsed = JSON.parse(raw);
    } catch {
      this.state = { reminders: [] };
      return;
    }

    const reminders = Array.isArray(parsed?.reminders) ? parsed.reminders : [];
    const needsMigrationBackup = reminders.some((entry) => entry && typeof entry === "object" && entry.kind === undefined);
    if (needsMigrationBackup) {
      this.writeMigrationBackupOnce(raw);
    }

    this.state = {
      reminders: reminders
        .map(normalizeReminder)
        .filter(Boolean)
        .sort(compareByDueAt),
    };
  }

  writeMigrationBackupOnce(rawContent) {
    try {
      const dir = path.dirname(this.filePath);
      const base = path.basename(this.filePath, path.extname(this.filePath));
      const ext = path.extname(this.filePath) || ".json";
      const existing = fs.readdirSync(dir).filter((name) => name.startsWith(`${base}.backup-`));
      if (existing.length) {
        return;
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = path.join(dir, `${base}.backup-${stamp}${ext}`);
      fs.writeFileSync(backupPath, rawContent);
    } catch {
      // Best-effort; never block load on backup failure.
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  enqueue(reminder) {
    this.load();
    const normalized = normalizeReminder(reminder);
    if (!normalized) {
      throw new Error("invalid reminder");
    }
    this.state.reminders.push(normalized);
    this.state.reminders.sort(compareByDueAt);
    this.save();
    return normalized;
  }

  // Read-only. Returns reminders whose dueAtMs has passed AND that are not
  // temp reminders already in pending-ack state (lastFiredAt set).
  listDue(nowMs = Date.now()) {
    this.load();
    return this.state.reminders.filter((reminder) => isPendingDispatch(reminder, nowMs));
  }

  update(id, partial = {}) {
    const trimmedId = typeof id === "string" ? id.trim() : "";
    if (!trimmedId) {
      return null;
    }
    this.load();
    const index = this.state.reminders.findIndex((entry) => entry.id === trimmedId);
    if (index === -1) {
      return null;
    }
    const merged = { ...this.state.reminders[index], ...partial, id: trimmedId };
    const normalized = normalizeReminder(merged);
    if (!normalized) {
      return null;
    }
    this.state.reminders[index] = normalized;
    this.state.reminders.sort(compareByDueAt);
    this.save();
    return normalized;
  }

  // Idempotent removal. Returns the removed reminder or null.
  remove(id) {
    const trimmedId = typeof id === "string" ? id.trim() : "";
    if (!trimmedId) {
      return null;
    }
    this.load();
    const index = this.state.reminders.findIndex((entry) => entry.id === trimmedId);
    if (index === -1) {
      return null;
    }
    const [removed] = this.state.reminders.splice(index, 1);
    this.save();
    return removed;
  }

  acknowledge(id) {
    return this.remove(id);
  }

  peekNextDueAtMs() {
    this.load();
    for (const reminder of this.state.reminders) {
      // Skip temps that have already fired and are awaiting ack — they should
      // not drive the long-poll timeout. peekNextDueAtMs only reports dispatchable
      // future work.
      if (reminder.kind === REMINDER_KIND_TEMP && reminder.lastFiredAt) {
        continue;
      }
      if (Number.isFinite(reminder.dueAtMs) && reminder.dueAtMs > 0) {
        return reminder.dueAtMs;
      }
    }
    return 0;
  }

  // For check-in trigger augmentation. Returns temp reminders that have already
  // fired and are awaiting ack, scoped to the given account. Optional sender filter.
  listPendingTemp({ accountId = "", senderId = "" } = {}) {
    this.load();
    return this.state.reminders.filter((reminder) => {
      if (reminder.kind !== REMINDER_KIND_TEMP) return false;
      if (!reminder.lastFiredAt) return false;
      if (accountId && reminder.accountId !== accountId) return false;
      if (senderId && reminder.senderId !== senderId) return false;
      return true;
    });
  }
}

function isPendingDispatch(reminder, nowMs) {
  if (!reminder || !Number.isFinite(reminder.dueAtMs) || reminder.dueAtMs > nowMs) {
    return false;
  }
  // A temp reminder already in pending-ack state must not fire again from the
  // due-time loop. Re-engagement happens via the random check-in trigger surface.
  if (reminder.kind === REMINDER_KIND_TEMP && reminder.lastFiredAt) {
    return false;
  }
  return true;
}

function compareByDueAt(left, right) {
  return (left.dueAtMs || 0) - (right.dueAtMs || 0);
}

function normalizeReminder(reminder) {
  if (!reminder || typeof reminder !== "object") {
    return null;
  }
  const id = trimString(reminder.id);
  const accountId = trimString(reminder.accountId);
  const senderId = trimString(reminder.senderId);
  const contextToken = trimString(reminder.contextToken);
  const text = trimString(reminder.text);
  const dueAtMs = Number(reminder.dueAtMs);
  const createdAt = trimString(reminder.createdAt) || new Date().toISOString();
  if (!id || !accountId || !senderId || !contextToken || !text || !Number.isFinite(dueAtMs) || dueAtMs <= 0) {
    return null;
  }

  const kindRaw = trimString(reminder.kind).toLowerCase();
  const kind = VALID_KINDS.has(kindRaw) ? kindRaw : REMINDER_KIND_TEMP;

  const out = {
    id,
    accountId,
    senderId,
    contextToken,
    text,
    dueAtMs,
    createdAt,
    kind,
    lastFiredAt: trimString(reminder.lastFiredAt),
  };

  if (kind === REMINDER_KIND_RECURRING) {
    const periodMs = Number(reminder.periodMs);
    if (!Number.isFinite(periodMs) || periodMs <= 0) {
      // Recurring without a valid period is not a usable schedule.
      return null;
    }
    out.periodMs = periodMs;
    const activeHours = normalizeActiveHours(reminder.activeHours);
    if (activeHours) {
      out.activeHours = activeHours;
    }
    const activeWeekdays = normalizeActiveWeekdays(reminder.activeWeekdays);
    if (activeWeekdays) {
      out.activeWeekdays = activeWeekdays;
    }
  }

  return out;
}

function normalizeActiveHours(value) {
  const text = trimString(value);
  if (!text) return "";
  const match = text.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!match) return "";
  const startH = Number.parseInt(match[1], 10);
  const startM = Number.parseInt(match[2], 10);
  const endH = Number.parseInt(match[3], 10);
  const endM = Number.parseInt(match[4], 10);
  if (
    !Number.isFinite(startH) || startH < 0 || startH > 23 ||
    !Number.isFinite(endH) || endH < 0 || endH > 23 ||
    !Number.isFinite(startM) || startM < 0 || startM > 59 ||
    !Number.isFinite(endM) || endM < 0 || endM > 59
  ) {
    return "";
  }
  // Reject zero-width ranges. start==end is ambiguous (could mean "always" or
  // "never"); accepting it would let computeNextRecurringDueAtMs spin against
  // the safety cap. Users who want 24h coverage should simply omit activeHours.
  if (startH === endH && startM === endM) {
    return "";
  }
  return `${pad2(startH)}:${pad2(startM)}-${pad2(endH)}:${pad2(endM)}`;
}

function normalizeActiveWeekdays(value) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  for (const entry of value) {
    const n = Number(entry);
    if (!Number.isInteger(n) || n < 0 || n > 6) continue;
    seen.add(n);
  }
  if (!seen.size) return null;
  return Array.from(seen).sort((a, b) => a - b);
}

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

module.exports = {
  ReminderQueueStore,
  normalizeReminder,
  REMINDER_KIND_TEMP,
  REMINDER_KIND_RECURRING,
};
