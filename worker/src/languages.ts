// The languages a text can be summarised in or translated between, with the
// names people (and the model prompts) use. Codes are ISO 639-1, plus grc
// (Ancient Greek, ISO 639-2), which legacy offered. "auto-detect" is a source
// choice only. The client's menus import this list.
export const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian", pt: "Portuguese", ru: "Russian",
  zh: "Chinese", ja: "Japanese", ko: "Korean", ar: "Arabic", hi: "Hindi", nl: "Dutch", sv: "Swedish",
  da: "Danish", no: "Norwegian", fi: "Finnish", pl: "Polish", cs: "Czech", el: "Greek (modern)", grc: "Ancient Greek",
  tr: "Turkish", he: "Hebrew", yi: "Yiddish", th: "Thai", vi: "Vietnamese", uk: "Ukrainian", ro: "Romanian",
  hu: "Hungarian", id: "Indonesian", ms: "Malay", ca: "Catalan", hr: "Croatian", sk: "Slovak", bg: "Bulgarian",
  sr: "Serbian", lt: "Lithuanian", lv: "Latvian", et: "Estonian", sl: "Slovenian", ga: "Irish", sq: "Albanian",
  mk: "Macedonian", bs: "Bosnian", mt: "Maltese", is: "Icelandic", cy: "Welsh", la: "Latin",
};

export const AUTO_DETECT = "auto-detect";

/** Every code a route accepts, auto-detect included. */
export const LANGUAGE_CODES: ReadonlySet<string> = new Set([...Object.keys(LANGUAGE_NAMES), AUTO_DETECT]);

/** The name for a prompt or a menu; an unknown code is returned as given, auto-detect is described. */
export function languageName(code: string | null | undefined): string {
  if (!code) return "";
  if (code === AUTO_DETECT) return "the language of the text (detect it)";
  return LANGUAGE_NAMES[code] ?? code;
}

/** Menu entries sorted by name, English first (the usual target). */
export function languageOptions(): { code: string; name: string }[] {
  return Object.entries(LANGUAGE_NAMES)
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => (a.code === "en" ? -1 : b.code === "en" ? 1 : a.name.localeCompare(b.name)));
}
