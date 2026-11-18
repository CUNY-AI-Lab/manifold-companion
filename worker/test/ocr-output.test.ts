import { describe, expect, it } from "vitest";
import { parseOcr } from "../src/task-specs";
import { DEFAULT_OCR_PROMPT } from "../src/prompts";
import { OCR_PRESETS } from "../src/ocr-presets";

describe("OCR output has no horizontal rules (Manifold draws each one across the page)", () => {
  it("drops ---, *** and ___ lines the model wrote, keeping the text around them", () => {
    // Page 6 of a play as one model returned it: a rule under the character list.
    const raw = "CHARACTERS:\n\nA BLIND MAN.\nA CAVALIER.\n\n---\n\nA Plain, a Cemetery, a Garden.";
    expect(parseOcr(raw)).toBe("CHARACTERS:\n\nA BLIND MAN.\nA CAVALIER.\n\nA Plain, a Cemetery, a Garden.");
    expect(parseOcr("One.\n\n* * *\n\nTwo.\n\n___\n\nThree.\n\n- - -")).toBe("One.\n\nTwo.\n\nThree.");
  });
  it("leaves tables, lists, dashes in prose and bold text alone", () => {
    const keep = "| a | b |\n|---|---|\n| 1 | 2 |\n\n- item\n\nA dash -- here, and --- there.\n\n**THE CAVALIER**\nAlmost.";
    expect(parseOcr(keep)).toBe(keep);
  });
  it("no prompt asks for rules; every prompt gives speaker names one form", () => {
    for (const prompt of [DEFAULT_OCR_PROMPT, ...OCR_PRESETS.map((p) => p.prompt)]) {
      expect(prompt).not.toMatch(/^- --- for/m);
      expect(prompt).toMatch(/Never write a horizontal rule/);
      expect(prompt).toMatch(/speaker's name in bold on its own line/);
      expect(prompt).not.toMatch(/centered headings/);
    }
  });
});
