const crypto = require("crypto");

const { resolveSelectedAccount } = require("../adapters/channel/weixin/account-store");
const { loadPersistedContextTokens } = require("../adapters/channel/weixin/context-token-store");
const {
  ReminderQueueStore,
  REMINDER_KIND_TEMP,
  REMINDER_KIND_RECURRING,
} = require("../adapters/channel/weixin/reminder-queue-store");
const { resolvePreferredSenderId } = require("../core/default-targets");
const { resolveBodyInput } = require("./text-input");

const DELAY_UNIT_MS = {
  s: 1_000,
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
};
const LOCAL_TIMEZONE_OFFSET = "+08:00";

const PERIOD_UNIT_MS = {
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
  w: 7 * 24 * 60 * 60_000,
};
const MIN_PERIOD_MS = 60_000; // 1 minute floor — anything tighter is almost certainly a bug.

class ReminderService {
  constructor({ config, sessionStore }) {
    this.config = config;
    this.sessionStore = sessionStore;
    this.queue = new ReminderQueueStore({ filePath: config.reminderQueueFile });
  }

  async create({
    delay = "",
    delayMinutes = undefined,
    at = "",
    dueAt = "",
    text = "",
    textFile = "",
    userId = "",
    kind = "",
    periodMs = undefined,
    period = "",
    activeHours = "",
    activeWeekdays = undefined,
  } = {}, context = {}) {
    const body = await resolveBodyInput({ text, textFile });
    if (!body) {
      throw new Error("Reminder text cannot be empty. Pass text or textFile.");
    }

    const dueAtMs = resolveDueAtMs({ delay, delayMinutes, at, dueAt });
    if (!Number.isFinite(dueAtMs) || dueAtMs <= Date.now()) {
      throw new Error("Missing a valid time. Use delayMinutes or dueAt like 2026-04-07T21:30+08:00.");
    }

    const account = resolveSelectedAccount(this.config);
    const senderId = resolveReminderSenderId({
      config: this.config,
      accountId: account.accountId,
      explicitUser: userId,
      context,
      sessionStore: this.sessionStore,
    });
    if (!senderId) {
      throw new Error("Cannot determine the WeChat user for this reminder.");
    }

    const contextTokens = loadPersistedContextTokens(this.config, account.accountId);
    const contextToken = String(contextTokens[senderId] || "").trim();
    if (!contextToken) {
      throw new Error(`Cannot find context_token for ${senderId}. Let this user talk to the bot once first.`);
    }

    const resolvedKind = resolveReminderKind(kind);
    const entry = {
      id: crypto.randomUUID(),
      accountId: account.accountId,
      senderId,
      contextToken,
      text: body,
      dueAtMs,
      createdAt: new Date().toISOString(),
      kind: resolvedKind,
    };

    if (resolvedKind === REMINDER_KIND_RECURRING) {
      const resolvedPeriodMs = resolvePeriodMs({ periodMs, period });
      if (!Number.isFinite(resolvedPeriodMs) || resolvedPeriodMs < MIN_PERIOD_MS) {
        throw new Error("Recurring reminders need a periodMs (>= 60000) or period like '1h', '30m', '1d'.");
      }
      entry.periodMs = resolvedPeriodMs;
      const normalizedActiveHours = String(activeHours || "").trim();
      if (normalizedActiveHours) {
        entry.activeHours = normalizedActiveHours;
      }
      if (Array.isArray(activeWeekdays) && activeWeekdays.length) {
        entry.activeWeekdays = activeWeekdays;
      }
    }

    return this.queue.enqueue(entry);
  }

  acknowledge({ id = "", userId = "" } = {}, context = {}) {
    return this.removeScoped(id, { explicitUser: userId, context, action: "ack" });
  }

  delete({ id = "", userId = "" } = {}, context = {}) {
    return this.removeScoped(id, { explicitUser: userId, context, action: "delete" });
  }

  removeScoped(id, { explicitUser = "", context = {}, action = "remove" } = {}) {
    const trimmedId = typeof id === "string" ? id.trim() : "";
    if (!trimmedId) {
      throw new Error("Reminder id is required.");
    }
    const account = resolveSelectedAccount(this.config);
    const senderId = resolveReminderSenderId({
      config: this.config,
      accountId: account.accountId,
      explicitUser,
      context,
      sessionStore: this.sessionStore,
    });

    this.queue.load();
    const entry = (this.queue.state?.reminders || []).find((reminder) => reminder.id === trimmedId);
    if (!entry) {
      // Idempotent: missing id is success, not error. The AI may chase the same
      // ack twice as the conversation evolves; both calls should succeed.
      return { id: trimmedId, action, removed: false, reason: "not_found" };
    }
    if (entry.accountId !== account.accountId) {
      throw new Error("Reminder belongs to a different account.");
    }
    if (senderId && entry.senderId !== senderId) {
      throw new Error("Reminder belongs to a different WeChat user.");
    }
    const removed = this.queue.remove(trimmedId);
    return {
      id: trimmedId,
      action,
      removed: Boolean(removed),
      kind: entry.kind,
      text: entry.text,
    };
  }

  list({ limit = 0, userId = "" } = {}, context = {}) {
    this.queue.load();
    const all = Array.isArray(this.queue.state?.reminders) ? this.queue.state.reminders.slice() : [];

    const account = resolveSelectedAccount(this.config);
    const senderFilter = resolveReminderSenderId({
      config: this.config,
      accountId: account.accountId,
      explicitUser: userId,
      context,
      sessionStore: this.sessionStore,
    });

    const filtered = all
      .filter((reminder) => reminder.accountId === account.accountId)
      .filter((reminder) => !senderFilter || reminder.senderId === senderFilter);
    const safeLimit = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : 0;
    const limited = safeLimit > 0 ? filtered.slice(0, safeLimit) : filtered;

    const nowMs = Date.now();
    return {
      total: filtered.length,
      senderId: senderFilter || "",
      reminders: limited.map((reminder) => sanitizeReminderForOutput(reminder, nowMs)),
    };
  }
}

function resolveReminderKind(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (text === REMINDER_KIND_RECURRING) {
    return REMINDER_KIND_RECURRING;
  }
  return REMINDER_KIND_TEMP;
}

function resolvePeriodMs({ periodMs, period }) {
  const direct = Number(periodMs);
  if (Number.isFinite(direct) && direct > 0) {
    return direct;
  }
  return parsePeriod(period);
}

function parsePeriod(rawValue) {
  const normalized = String(rawValue || "").trim().toLowerCase();
  if (!normalized) {
    return 0;
  }
  let totalMs = 0;
  let index = 0;
  while (index < normalized.length) {
    while (index < normalized.length && /\s/.test(normalized[index])) index += 1;
    if (index >= normalized.length) break;
    const match = normalized.slice(index).match(/^(\d+)\s*([smhdw])/);
    if (!match) return 0;
    const amount = Number.parseInt(match[1], 10);
    const unit = match[2] === "s" ? "m" : match[2]; // treat "s" as nonsense and round up to minute floor
    const unitMs = PERIOD_UNIT_MS[unit] || 0;
    if (!Number.isFinite(amount) || amount <= 0 || !unitMs) return 0;
    totalMs += amount * unitMs;
    index += match[0].length;
  }
  return totalMs > 0 ? totalMs : 0;
}

function resolveReminderSenderId({ config, accountId, explicitUser = "", context = {}, sessionStore = null }) {
  const explicit = normalizeText(explicitUser);
  if (explicit) {
    return explicit;
  }
  const contextual = normalizeText(context?.senderId);
  if (contextual) {
    return contextual;
  }
  return resolvePreferredSenderId({
    config,
    accountId,
    sessionStore,
  });
}

function resolveDueAtMs({ delay = "", delayMinutes = undefined, at = "", dueAt = "" } = {}) {
  const delayMs = parseDelay(delay);
  const normalizedDelayMinutes = parseDelayMinutes(delayMinutes);
  const scheduledAtMs = parseAbsoluteTime(dueAt || at);
  const timeSourceCount = [delayMs, normalizedDelayMinutes, scheduledAtMs].filter((value) => value > 0).length;
  if (timeSourceCount > 1) {
    throw new Error("Use only one of delay, delayMinutes, at, or dueAt.");
  }
  if (delayMs) {
    return Date.now() + delayMs;
  }
  if (normalizedDelayMinutes) {
    return Date.now() + normalizedDelayMinutes;
  }
  if (scheduledAtMs) {
    return scheduledAtMs;
  }
  return 0;
}

function parseDelayMinutes(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return 0;
  }
  const parsed = Number.parseInt(String(rawValue), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 60_000 : 0;
}

function parseDelay(rawValue) {
  const normalized = String(rawValue || "").trim().toLowerCase();
  if (!normalized) {
    return 0;
  }

  let totalMs = 0;
  let index = 0;
  while (index < normalized.length) {
    while (index < normalized.length && /\s/.test(normalized[index])) {
      index += 1;
    }
    if (index >= normalized.length) {
      break;
    }

    const match = normalized.slice(index).match(/^(\d+)\s*([smhd])/);
    if (!match) {
      return 0;
    }

    const amount = Number.parseInt(match[1], 10);
    const unitMs = DELAY_UNIT_MS[match[2]] || 0;
    if (!Number.isFinite(amount) || amount <= 0 || !unitMs) {
      return 0;
    }

    totalMs += amount * unitMs;
    index += match[0].length;
  }

  return totalMs > 0 ? totalMs : 0;
}

function parseAbsoluteTime(rawValue) {
  const normalized = String(rawValue || "").trim();
  if (!normalized) {
    return 0;
  }

  const normalizedIso = normalizeAbsoluteTimeString(normalized);
  const parsed = Date.parse(normalizedIso);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeAbsoluteTimeString(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }

  if (/([zZ]|[+-]\d{2}:\d{2})$/.test(normalized)) {
    return normalized.replace(" ", "T");
  }

  const dateTimeMatch = normalized.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/);
  if (dateTimeMatch) {
    return `${dateTimeMatch[1]}T${dateTimeMatch[2]}${LOCAL_TIMEZONE_OFFSET}`;
  }

  const dateOnlyMatch = normalized.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (dateOnlyMatch) {
    return `${dateOnlyMatch[1]}T09:00:00${LOCAL_TIMEZONE_OFFSET}`;
  }

  return normalized;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sanitizeReminderForOutput(reminder, nowMs) {
  const dueAtMs = Number(reminder?.dueAtMs);
  const overdue = Number.isFinite(dueAtMs) ? dueAtMs <= nowMs : false;
  const dueIn = Number.isFinite(dueAtMs) ? Math.max(0, dueAtMs - nowMs) : 0;
  const lastFiredAt = typeof reminder?.lastFiredAt === "string" ? reminder.lastFiredAt : "";
  const lastFiredAtMs = lastFiredAt ? Date.parse(lastFiredAt) : NaN;
  const pendingMs = Number.isFinite(lastFiredAtMs) ? Math.max(0, nowMs - lastFiredAtMs) : 0;
  const out = {
    id: reminder?.id || "",
    senderId: reminder?.senderId || "",
    text: reminder?.text || "",
    dueAtMs: Number.isFinite(dueAtMs) ? dueAtMs : 0,
    dueAtIso: Number.isFinite(dueAtMs) ? new Date(dueAtMs).toISOString() : "",
    dueInMs: dueIn,
    dueInMinutes: Math.round(dueIn / 60000),
    overdue,
    createdAt: reminder?.createdAt || "",
    kind: reminder?.kind || REMINDER_KIND_TEMP,
    lastFiredAt,
    pendingMs,
    pendingHours: pendingMs ? Math.round(pendingMs / 3600000) : 0,
  };
  if (reminder?.kind === REMINDER_KIND_RECURRING) {
    if (Number.isFinite(reminder.periodMs)) out.periodMs = reminder.periodMs;
    if (reminder.activeHours) out.activeHours = reminder.activeHours;
    if (reminder.activeWeekdays) out.activeWeekdays = reminder.activeWeekdays;
  }
  return out;
}

module.exports = {
  ReminderService,
  parseAbsoluteTime,
  parseDelay,
  parseDelayMinutes,
  parsePeriod,
  resolveDueAtMs,
};
