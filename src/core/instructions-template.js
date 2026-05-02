function resolveUserPronoun(gender) {
  const normalized = String(gender || "").trim().toLowerCase();
  if (normalized === "male" || normalized === "man" || normalized === "m" || normalized === "男") {
    return "他";
  }
  if (normalized === "neutral" || normalized === "nonbinary" || normalized === "nb" || normalized === "ta") {
    return "TA";
  }
  return "她";
}

const LANGUAGE_DISPLAY_NAMES = {
  en: "English",
  zh: "Chinese",
};

function buildResponseLanguageInstruction(language) {
  const lang = String(language || "").trim().toLowerCase();
  if (!lang || lang === "auto") {
    return "";
  }
  const displayName = LANGUAGE_DISPLAY_NAMES[lang] || lang;
  return `\nIMPORTANT: You MUST respond in ${displayName} regardless of the user's language. This is a strict requirement.\n`;
}

function renderInstructionTemplate(template, config = {}) {
  const userName = String(config?.userName || "").trim() || "用户";
  const pronoun = resolveUserPronoun(config?.userGender);
  const langInstruction = buildResponseLanguageInstruction(config?.responseLanguage);
  return String(template || "")
    .replaceAll("{{USER_NAME}}", userName)
    .replaceAll("{{RESPONSE_LANGUAGE}}", langInstruction)
    .replaceAll("她", pronoun);
}

module.exports = {
  renderInstructionTemplate,
  resolveUserPronoun,
};
