const fs = require("fs");
const path = require("path");

const VALID_CLOSE_REASONS = new Set(["ack", "delete"]);
const VALID_CLOSED_BY = new Set(["user", "ai", "ai-checkin", "dream", "manual"]);

class ReminderDoneStore {
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
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const reminders = Array.isArray(parsed?.reminders) ? parsed.reminders : [];
      this.state = { reminders };
    } catch {
      this.state = { reminders: [] };
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  // Append a closed reminder. Adds closure metadata; preserves the original
  // reminder fields verbatim so dream / audit code can reason about the full
  // history without re-deriving anything.
  archive(reminder, { closeReason, closedBy = "ai", closedAt = "" } = {}) {
    if (!reminder || typeof reminder !== "object") {
      return null;
    }
    const reason = VALID_CLOSE_REASONS.has(closeReason) ? closeReason : null;
    if (!reason) {
      throw new Error(`invalid closeReason: ${closeReason}`);
    }
    const by = VALID_CLOSED_BY.has(closedBy) ? closedBy : "ai";
    const at = typeof closedAt === "string" && closedAt ? closedAt : new Date().toISOString();
    const entry = {
      ...reminder,
      closedAt: at,
      closeReason: reason,
      closedBy: by,
    };
    this.load();
    this.state.reminders.push(entry);
    this.save();
    return entry;
  }

  // Read-only filter for dream / morning summary use. By default returns
  // entries closed within the trailing N hours.
  listClosedSince(sinceMs, { accountId = "", senderId = "" } = {}) {
    this.load();
    return this.state.reminders.filter((entry) => {
      const closedMs = Date.parse(entry?.closedAt || "");
      if (!Number.isFinite(closedMs) || closedMs < sinceMs) return false;
      if (accountId && entry?.accountId !== accountId) return false;
      if (senderId && entry?.senderId !== senderId) return false;
      return true;
    });
  }
}

module.exports = {
  ReminderDoneStore,
  VALID_CLOSE_REASONS,
  VALID_CLOSED_BY,
};
