// Pure recurring-schedule helpers. Kept in its own module so they are easy to
// unit-test without spinning up the whole app.

const HOUR_MS = 3_600_000;
const SAFETY_MAX_ITERATIONS = 24 * 14; // up to 14 days of hourly steps

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function computeNextRecurringDueAtMs(reminder, nowMs, timezone) {
  const periodMs = Number(reminder?.periodMs);
  const baseDueAt = Number(reminder?.dueAtMs);
  if (!Number.isFinite(periodMs) || periodMs <= 0 || !Number.isFinite(baseDueAt)) {
    return baseDueAt; // degenerate; do not crash, caller will eventually skip it
  }

  let next = baseDueAt + periodMs;
  // Catch up past any backlog so a long offline gap does not cause a flood
  // of fires on resume.
  while (next <= nowMs) {
    next += periodMs;
  }

  if (!hasActiveWindow(reminder)) {
    return next;
  }

  // Skip occurrences that fall outside the active window.
  let safety = 0;
  while (!isWithinActiveWindow(next, reminder, timezone) && safety < SAFETY_MAX_ITERATIONS) {
    next += periodMs;
    safety += 1;
  }
  return next;
}

function hasActiveWindow(reminder) {
  return Boolean(reminder?.activeHours) || (Array.isArray(reminder?.activeWeekdays) && reminder.activeWeekdays.length > 0);
}

function isWithinActiveWindow(ms, reminder, timezone) {
  const parts = getLocalParts(ms, timezone);
  if (!parts) {
    return true; // If timezone parsing fails, do not block — fall back to firing.
  }
  if (Array.isArray(reminder?.activeWeekdays) && reminder.activeWeekdays.length > 0) {
    if (!reminder.activeWeekdays.includes(parts.weekday)) {
      return false;
    }
  }
  if (reminder?.activeHours) {
    const range = parseHourRange(reminder.activeHours);
    if (range) {
      const minute = parts.hour * 60 + parts.minute;
      const inside = range.startMin <= range.endMin
        ? minute >= range.startMin && minute < range.endMin
        : minute >= range.startMin || minute < range.endMin;
      if (!inside) return false;
    }
  }
  return true;
}

function getLocalParts(ms, timezone) {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || undefined,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date(ms));
    const map = {};
    for (const part of parts) map[part.type] = part.value;
    const weekday = WEEKDAY_INDEX[map.weekday];
    let hour = Number.parseInt(map.hour, 10);
    if (hour === 24) hour = 0; // some locales render midnight as "24"
    const minute = Number.parseInt(map.minute, 10);
    if (
      !Number.isInteger(weekday) ||
      !Number.isFinite(hour) ||
      !Number.isFinite(minute)
    ) {
      return null;
    }
    return { weekday, hour, minute };
  } catch {
    return null;
  }
}

function parseHourRange(text) {
  const match = String(text || "").trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const startMin = Number.parseInt(match[1], 10) * 60 + Number.parseInt(match[2], 10);
  const endMin = Number.parseInt(match[3], 10) * 60 + Number.parseInt(match[4], 10);
  if (!Number.isFinite(startMin) || !Number.isFinite(endMin)) return null;
  return { startMin, endMin };
}

module.exports = {
  computeNextRecurringDueAtMs,
  isWithinActiveWindow,
  hasActiveWindow,
  HOUR_MS,
};
