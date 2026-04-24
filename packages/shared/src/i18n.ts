export type Lang = "en" | "ja" | "zh" | "ko" | "ru";

let _lang: Lang = "en";

export function setLang(lang: Lang): void {
  _lang = lang;
}

export function getLang(): Lang {
  return _lang;
}

/**
 * Maps each language to the display name passed to Claude when generating PR
 * metadata. English is null — no instruction is needed since Claude defaults to
 * English.
 */
const PR_LANGUAGE_NAMES: Record<Lang, string | null> = {
  en: null,
  ja: "Japanese (日本語)",
  zh: "Chinese Simplified (简体中文)",
  ko: "Korean (한국어)",
  ru: "Russian (русский)",
};

/**
 * Returns the language name to request in the PR metadata prompt, or null if
 * no instruction is needed (i.e. the language is English).
 */
export function getPRLanguage(): string | null {
  return PR_LANGUAGE_NAMES[_lang];
}

/**
 * Detect language from CLI args, CLAUDE_CODE_LOCALE, or system LANG.
 * Priority: --lang=<code> > CLAUDE_CODE_LOCALE > system LANG > "en"
 */
export function detectLang(): Lang {
  const langArg = process.argv.find((a) => a.startsWith("--lang="));
  if (langArg) {
    const val = langArg.split("=")[1]?.toLowerCase();
    if (val === "en") return "en";
    if (val === "jp" || val === "ja") return "ja";
    if (val === "zh" || val === "zh-cn" || val === "zh_cn") return "zh";
    if (val === "ko") return "ko";
    if (val === "ru") return "ru";
  }

  const claudeLocale = process.env.CLAUDE_CODE_LOCALE;
  if (claudeLocale?.toLowerCase().startsWith("ja")) return "ja";
  if (claudeLocale?.toLowerCase().startsWith("zh")) return "zh";
  if (claudeLocale?.toLowerCase().startsWith("ko")) return "ko";
  if (claudeLocale?.toLowerCase().startsWith("ru")) return "ru";

  const sysLang = process.env.LANG;
  if (sysLang?.toLowerCase().startsWith("ja")) return "ja";
  if (sysLang?.toLowerCase().startsWith("zh")) return "zh";
  if (sysLang?.toLowerCase().startsWith("ko")) return "ko";
  if (sysLang?.toLowerCase().startsWith("ru")) return "ru";

  return "en";
}
