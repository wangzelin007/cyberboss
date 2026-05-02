const fs = require("fs");
const path = require("path");

const { resolveBodyInput } = require("./text-input");

class DiaryService {
  constructor({ config }) {
    this.config = config;
  }

  async append({ text = "", textFile = "", title = "", date = "", time = "" } = {}) {
    const body = await resolveBodyInput({ text, textFile });
    if (!body) {
      throw new Error("Diary content cannot be empty. Pass text or textFile.");
    }

    const now = new Date();
    const dateString = date || formatDate(now, this.config.timezone);
    const timeString = time || formatTime(now, this.config.timezone);
    const filePath = path.join(this.config.diaryDir, `${dateString}.md`);
    const entry = buildDiaryEntry({
      timeString,
      title,
      body,
    });

    fs.mkdirSync(this.config.diaryDir, { recursive: true });
    const prefix = fs.existsSync(filePath) && fs.statSync(filePath).size > 0 ? "\n\n" : "";
    fs.appendFileSync(filePath, `${prefix}${entry}`, "utf8");
    return {
      filePath,
      date: dateString,
      time: timeString,
      body,
    };
  }
}

function buildDiaryEntry({ timeString, title, body }) {
  const heading = title ? `## ${timeString} ${String(title).trim()}` : `## ${timeString}`;
  return `${heading}\n\n${body}`;
}

function formatDate(date, timezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatTime(date, timezone) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

module.exports = {
  DiaryService,
  buildDiaryEntry,
  formatDate,
  formatTime,
};
