#!/usr/bin/env node
// Live evaluation of every Manifold Companion model task through the REAL CAIL
// Gateway, with the Worker's own code: request builders, prompts, model
// selection, token budgets, reasoning controls, deadlines, one attempt per
// call with a fresh request id, and the shipped output parsers and sanitizer.
//
//   pbpaste | node worker/scripts/live-eval.mjs                 # the run
//   node worker/scripts/live-eval.mjs --dry-run                 # the plan; only the public catalog is fetched
//   node worker/scripts/live-eval.mjs --help
//
// The personal key (sk-cail-...) is read ONCE from stdin and sent only as
// `Authorization: Bearer` by cail-client (kind "key"). It is never accepted as
// an argument or environment variable, never printed and never written; every
// message and file is checked and redacted.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const here = import.meta.dirname;
const worker = resolve(here, "..");
const SCRATCH = "/private/tmp/claude-501/-Users-veritas44/6baba7e7-4a09-49f3-9f44-2c71dcfbdb3f/scratchpad";
const BASE = "https://tools.ailab.gc.cuny.edu"; // cail-client appends /v1/...

let KEY = null;
const scrub = (s) => {
  let t = String(s);
  if (KEY) t = t.split(`Bearer ${KEY}`).join("Bearer [redacted]").split(KEY).join("[redacted]");
  return t;
};
const say = (...parts) => process.stdout.write(`${scrub(parts.join(" "))}\n`);
const fail = (msg) => {
  process.stderr.write(`live-eval: ${scrub(msg)}\n`);
  process.exit(1);
};
process.on("uncaughtException", (e) => fail(`${e?.name ?? "Error"}: ${e?.message ?? e}`));
process.on("unhandledRejection", (e) => fail(`${e?.name ?? "Error"}: ${e?.message ?? e}`));

/** Every file goes through here: nothing containing the key is ever written. */
function writeOut(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  if (KEY && text.includes(KEY)) fail(`refusing to write ${path}: it would contain the key`);
  writeFileSync(path, text);
}

// ---- load the Worker's modules ------------------------------------------------

async function loadLib(outDir) {
  const { build } = await import(pathToFileURL(join(worker, "node_modules/esbuild/lib/main.js")).href);
  const outfile = join(outDir, ".bundle", "live-eval-lib.mjs");
  await build({ entryPoints: [join(here, "live-eval-entry.ts")], outfile, bundle: true, format: "esm", platform: "node", target: "node22", logLevel: "error", nodePaths: [join(worker, "node_modules"), join(worker, "client/node_modules")] });
  return import(pathToFileURL(outfile).href);
}

// ---- stdin key ---------------------------------------------------------------

async function readKey(lib) {
  if (process.stdin.isTTY) fail("pipe the key on stdin, for example: pbpaste | node worker/scripts/live-eval.mjs");
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const key = Buffer.concat(chunks).toString("utf8").trim();
  if (!key || /\s/.test(key)) fail("stdin must contain exactly one key and nothing else");
  if (!lib.looksLikeKey(key)) fail("stdin does not look like a personal CAIL key (sk-cail-...)");
  return key;
}

// ---- pages -------------------------------------------------------------------

function jpegSize(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return { width: 0, height: 0 };
}

/** Rasterise like the browser client: first dpi/quality that fits 3.5 MiB. */
function rasterise(lib, book, spec, kind, outDir) {
  const pdf = join(book, lib.BOOK_FILES[spec.pdf]);
  if (!existsSync(pdf)) fail(`missing ${pdf} (set --mathbook to the directory holding the chapter PDFs)`);
  for (const dpi of kind === "math" ? lib.RENDER.mathDpi : lib.RENDER.standardDpi) {
    for (const q of lib.RENDER.jpegQualities) {
      const base = join(outDir, "pages", `${spec.id}-${kind === "math" ? "math" : "std"}-${dpi}dpi-q${q}`);
      mkdirSync(dirname(base), { recursive: true });
      execFileSync("pdftoppm", ["-f", String(spec.page), "-l", String(spec.page), "-r", String(dpi), "-jpeg", "-jpegopt", `quality=${q}`, "-singlefile", pdf, base]);
      const file = `${base}.jpg`;
      const bytes = statSync(file).size;
      if (bytes <= lib.RENDER.maxBytes) {
        const buf = readFileSync(file);
        return { file, bytes, dpi, quality: q, ...jpegSize(buf), dataUri: `data:image/jpeg;base64,${buf.toString("base64")}` };
      }
    }
  }
  fail(`${spec.id} does not fit the 3.5 MiB page cap at any client scale`);
}

/** The text-layer hint. The client sends pdf.js text content joined by line; pdftotext is the closest local equivalent. */
function textHint(lib, book, spec) {
  return execFileSync("pdftotext", ["-f", String(spec.page), "-l", String(spec.page), "-enc", "UTF-8", join(book, lib.BOOK_FILES[spec.pdf]), "-"], { encoding: "utf8" });
}

// ---- main --------------------------------------------------------------------

const HELP = `Live evaluation of the Manifold Companion model tasks through the real CAIL Gateway.

  pbpaste | node worker/scripts/live-eval.mjs [flags]     run (key on stdin, once)
  node worker/scripts/live-eval.mjs --dry-run [flags]     plan only; fetches the public catalog, no key

Flags:
  --tasks ocr,html,math,summary,translate,repair   which tasks (default all)
  --models a,b                                     only these models (each must be on the task's menu)
  --pages ch7-p2,ch1-p35                           only these pages (ids in the plan)
  --budget-microdollars N                          stop before spending more (default 1500000 = $1.50)
  --budget-mode worst|expected                     budget check per call: worst case (default) or typical tokens
  --out DIR                                        output directory (default the scratchpad eval-out/)
  --mathbook DIR                                   directory with the chapter PDFs
`;

async function main() {
  const argv = process.argv.slice(2);
  let parsedEarly;
  try {
    // A key-shaped argument aborts before anything else happens.
    parsedEarly = argv;
    for (const a of argv) if (/sk-cail|^sk-[A-Za-z0-9_-]{16,}/.test(a)) fail("never pass the key as an argument; pipe it on stdin");
  } catch (e) {
    fail(e.message);
  }
  for (const name of ["CAIL_KEY", "CAIL_API_KEY", "LIVE_EVAL_KEY"]) if (process.env[name]) say(`note: ${name} is set in the environment and is ignored; the key is read from stdin only`);
  const out = resolve(argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : join(SCRATCH, "eval-out"));
  mkdirSync(out, { recursive: true });
  const lib = await loadLib(out);
  let args;
  try {
    args = lib.parseArgs(parsedEarly);
  } catch (e) {
    fail(e.message);
  }
  if (args.help) { process.stdout.write(HELP); return; }
  const book = resolve(args.mathbook ?? join(SCRATCH, "mathbook"));

  // The Worker's Gateway client over plain fetch: same client, no binding.
  const env = { GATEWAY: { fetch: (input, init) => fetch(input, init) }, CAIL_API_BASE: BASE };
  const client = lib.gatewayClient(env);
  const catalog = await lib.loadCatalog(client);
  const raw = await (await client.getCatalog()).json();
  const prices = new Map(raw.data.filter((r) => r.pricing && r.pricing.unit === "million_tokens").map((r) => [r.id, { input: r.pricing.input, output: r.pricing.output }]));

  // Pages, rendered as the client would.
  const pageSpecs = new Map(lib.PAGES.map((p) => [p.id, p]));
  if (args.pages) for (const id of args.pages) if (!pageSpecs.has(id)) fail(`unknown page ${id}; known: ${[...pageSpecs.keys()].join(", ")}`);
  const pagesFor = (task) => lib.PAGES_FOR[task].filter((id) => !args.pages || args.pages.includes(id));
  const images = {};
  const hints = {};
  for (const task of ["ocr", "html", "math"]) {
    if (!args.tasks.includes(task)) continue;
    for (const id of pagesFor(task)) {
      const kind = task === "math" ? "math" : "std";
      images[`${id}:${kind}`] ??= rasterise(lib, book, pageSpecs.get(id), kind, out);
      hints[id] ??= textHint(lib, book, pageSpecs.get(id));
    }
  }
  const sourceGuess = lib.PAGES_FOR.ocr.map((id) => textHint(lib, book, pageSpecs.get(id))).join("\n\n---\n\n");

  // The plan.
  const menus = {};
  const plan = [];
  let n = 0;
  const promptChars = { ocr: 1800, html: 3600, math: 3600 };
  // Order: cheap tasks first, the costly math comparison last, so a budget stop
  // never starves summary, translation or repair (repair takes a real formula from the HTML outputs).
  const ORDER = ["ocr", "html", "summary", "translate", "repair", "math"].filter((t) => args.tasks.includes(t));
  for (const task of ORDER) {
    const sets = lib.candidates(task, catalog, prices, args.models);
    menus[task] = { default: sets.default?.id ?? null, menu: sets.menu.map((m) => m.id), run: sets.run.map((m) => m.id) };
    const pages = task === "ocr" || task === "html" || task === "math" ? pagesFor(task) : [null];
    const units = task === "translate" ? ["it", "es"] : [null];
    for (const model of sets.run) {
      for (const page of pages) {
        for (const unit of units) {
          let est;
          if (page) {
            const img = images[`${page}:${task === "math" ? "math" : "std"}`];
            est = lib.estimateTextTokens(promptChars[task] + (task === "ocr" ? 0 : Math.min(8000, hints[page].length))) + lib.estimateImageTokens(img.width, img.height);
          } else {
            est = lib.estimateTextTokens(task === "summary" ? sourceGuess.length + 400 : task === "translate" ? 3000 + 300 : 600);
          }
          const call = lib.planCall(++n, task, page, model, model.id === sets.default?.id, est, prices.get(model.id) ?? null);
          call.unit = unit;
          plan.push(call);
        }
      }
    }
  }

  const sum = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0);
  let fitWorst = 0;
  let acc = 0;
  for (const c of plan) { if (lib.budgetAllows(acc, c, args.budgetMicrodollars, args.budgetMode)) { acc += args.budgetMode === "worst" ? c.worstMicro ?? 0 : c.expectedMicro ?? 0; fitWorst += 1; } }
  const planRows = plan.map((c) => `${String(c.n).padStart(3)}  ${c.task.padEnd(9)} ${(c.page ?? (c.unit ? `en->${c.unit}` : "-")).padEnd(8)} ${c.model.id.padEnd(30)} ${c.isDefault ? "default" : "       "} in~${String(c.estInputTokens).padStart(5)} out<=${String(c.maxTokens + c.headroom).padStart(5)} ${c.switches ? "think-off" : c.model.reasoning ? "think-on " : "         "} exp ${(c.expectedMicro === null ? "n/a" : `$${(c.expectedMicro / 1e6).toFixed(4)}`).padStart(8)} worst ${(c.worstMicro === null ? "n/a" : `$${(c.worstMicro / 1e6).toFixed(4)}`).padStart(8)}`);
  const header = [
    `Catalog: ${catalog.length} usable rows; prices for ${prices.size}.`,
    ...Object.entries(menus).map(([t, m]) => `  ${t.padEnd(9)} default ${m.default}; menu ${m.menu.length}; run: ${m.run.join(", ")}`),
    "Pages (client rendering rule: pdf.js scale 2 / math 3 => 144 / 216 dpi, JPEG q88, <= 3.5 MiB):",
    ...Object.entries(images).map(([k, v]) => `  ${k.padEnd(14)} ${v.width}x${v.height} ${v.dpi} dpi q${v.quality} ${v.bytes} bytes`),
    `Planned calls: ${plan.length}. Expected total ${`$${(sum(plan.map((c) => c.expectedMicro)) / 1e6).toFixed(2)}`}, worst case ${`$${(sum(plan.map((c) => c.worstMicro)) / 1e6).toFixed(2)}`}; budget $${(args.budgetMicrodollars / 1e6).toFixed(2)} (${args.budgetMode} case) allows ${fitWorst} of them; a call that could cross the budget is skipped and the run goes on with cheaper ones.`,
    "Token estimates are rough (image tokens from a 32 px grid); the report uses the usage the Gateway returns.",
  ];
  writeOut(join(out, "plan.json"), { budgetMicrodollars: args.budgetMicrodollars, budgetMode: args.budgetMode, menus, images: Object.fromEntries(Object.entries(images).map(([k, v]) => [k, { ...v, dataUri: undefined }])), plan: plan.map((c) => ({ ...c, model: c.model.id })) });
  if (args.dryRun) {
    say(header.join("\n"));
    say(planRows.join("\n"));
    say(`\nPlan written to ${join(out, "plan.json")}. No model was called.`);
    return;
  }

  KEY = await readKey(lib);
  const credential = { kind: "key", token: KEY };
  const principal = { subject: "live-eval", credential };
  const quota = async () => { try { const q = await client.getQuota(credential); return { limit: q.limit, estimated_used: q.estimated_used }; } catch (e) { say(`quota unavailable: ${e.code ?? e.name}`); return null; } };
  const quotaBefore = await quota();
  say(header.join("\n"));

  const records = [];
  const outputs = { ocr: new Map(), htmlish: [] };
  let spent = 0;
  let skipped = 0;
  const notes = ["Text-layer hints come from pdftotext, the nearest local equivalent of the pdf.js text the browser sends.", "Page images come from pdftoppm at the client's scales; the browser's canvas JPEG differs slightly in bytes."];
  const dir = (c) => join(out, "calls", c.task, c.page ?? c.unit ?? "text", c.model.id);

  for (const c of plan) {
    if (!lib.budgetAllows(spent, c, args.budgetMicrodollars, args.budgetMode)) { skipped += 1; continue; }
    // Inputs that depend on earlier calls.
    let task;
    let parse;
    let repairInfo = null;
    const img = c.page ? images[`${c.page}:${c.task === "math" ? "math" : "std"}`] : null;
    if (c.task === "ocr") {
      task = lib.ocrTask(c.model, img.dataUri);
      parse = (rawText) => { const text = lib.parseOcr(rawText); return { output: text, ext: "md", preview: lib.previewDocument({ markdown: text }), math: lib.scoreMath(text, true), structure: lib.markdownStructure(text), stripped: null }; };
    } else if (c.task === "html" || c.task === "math") {
      const spec = pageSpecs.get(c.page);
      task = lib.pageHtmlTask(c.model, { imageDataUri: img.dataUri, pageNumber: spec.page, totalPages: null, hint: hints[c.page], math: c.task === "math" });
      parse = (rawText) => {
        const { unsanitized, html } = lib.parsePageHtml(rawText, spec.page);
        // pipeline: everything the shipped post-processing + sanitizer removed from the model's HTML;
        // sanitizer: what the sanitizer alone removed after post-processing.
        const stripped = { pipeline: lib.strippedBySanitizer(lib.extractHtml(rawText), html), sanitizer: lib.strippedBySanitizer(unsanitized, html) };
        return { output: html, ext: "html", preview: lib.previewDocument({ html }), math: lib.scoreMath(html), structure: lib.htmlStructure(html), stripped };
      };
    } else if (c.task === "summary") {
      const source = [...outputs.ocr.values()].join("\n\n---\n\n") || sourceGuess;
      task = lib.summaryTask(c.model, source, "en").task;
      parse = (rawText) => { const s = lib.parseSummary(rawText); return { output: s, ext: "txt", preview: null, math: lib.scoreMath(s, true), structure: null, stripped: null, extra: { words: (s.match(/\S+/g) ?? []).length, english: lib.languageScore(s, "en") } }; };
    } else if (c.task === "translate") {
      const source = ([...outputs.ocr.values()].join("\n\n") || sourceGuess).split(/\n{2,}/).reduce((acc2, p) => (acc2.length + p.length + 2 <= 3000 ? (acc2 ? `${acc2}\n\n${p}` : p) : acc2), "");
      task = lib.translateTask(c.model, source, "en", c.unit);
      const sourceMath = lib.texFragments(source, true).length;
      parse = (rawText) => { const t = lib.parseTranslation(rawText); return { output: t, ext: "txt", preview: null, math: lib.scoreMath(t, true), structure: null, stripped: null, extra: { target: c.unit, targetLanguageScore: lib.languageScore(t, c.unit), englishScore: lib.languageScore(t, "en"), sourceMathFragments: sourceMath, ratio: t.length / Math.max(1, source.length) } }; };
    } else {
      const picked = lib.pickRepairSource(outputs.htmlish);
      const original = picked ?? "\\cos(\\theta)=\\frac{-3+\\sqrt{41}}{8}";
      const damaged = lib.damageFormula(original);
      repairInfo = { original, damaged, from: picked ? "a formula from this run's HTML output" : "page 7 of chapter 7 (no HTML output to take one from)" };
      task = lib.formulaRepairTask(c.model, [damaged]);
      parse = (rawText) => { const [r] = lib.parseFormulaRepair(rawText, [damaged]); return { output: JSON.stringify(r), ext: "json", preview: null, math: { total: 1, valid: lib.texParses(r.repaired) ? 1 : 0 }, structure: null, stripped: null, extra: { ...repairInfo, repaired: r.repaired, parses: lib.texParses(r.repaired), exact: r.repaired.replace(/\s+/g, "") === original.replace(/\s+/g, "") } }; };
    }

    let observed = null;
    task.observe = (o) => { observed = o; };
    const request = new Request("https://live-eval.invalid/");
    let rawText = null;
    let result = null;
    let error = null;
    try {
      const r = await lib.runChat(env, principal, request, task);
      rawText = r.text;
      try { result = parse(rawText); } catch (e) { error = { code: e.code ?? "parse_failed", message: e.message }; }
    } catch (e) {
      error = { code: e.code ?? e.name ?? "error", message: e.message ?? String(e) };
    }
    const u = lib.usageNumbers(observed?.usage ?? null);
    const catalogCost = lib.costMicro(u.prompt, u.completion, prices.get(c.model.id));
    const cost = u.reportedCostMicro ?? catalogCost;
    if (cost !== null) spent += cost;
    else if (observed?.status === 200) spent += c.worstMicro ?? 0; // unknown price: count the worst case against the budget
    const quality = result ? { ...(result.extra ?? {}), structure: result.structure, stripped: result.stripped, fence: lib.hasFence(rawText), refusal: lib.isRefusal(rawText), reasoningLeak: lib.leaksReasoning(rawText), invalidMath: result.math.invalidSamples ?? [] } : { refusal: rawText ? lib.isRefusal(rawText) : false };
    const record = {
      n: c.n, task: c.task, page: c.page ?? c.unit ?? null, model: c.model.id, isDefault: c.isDefault, reasoning: c.model.reasoning,
      ok: !!result, status: observed?.status ?? null, errorCode: error?.code ?? observed?.errorCode ?? null, finishReason: observed?.finishReason ?? null,
      promptTokens: u.prompt, completionTokens: u.completion, reasoningTokens: u.reasoning, usage: observed?.usage ?? null, provider: observed?.provider ?? null,
      latencyMs: observed?.latencyMs ?? 0, deadlineHit: observed?.deadlineHit ?? false, outputChars: rawText?.length ?? 0,
      maxTokensSent: c.maxTokens + c.headroom, thinkingSwitches: c.switches, imageBytes: img?.bytes ?? null,
      costMicro: cost, costSource: u.reportedCostMicro !== null ? "usage" : catalogCost !== null ? "catalog" : "none",
      quality, mathTotal: result?.math.total ?? 0, mathValid: result?.math.valid ?? 0,
      errorMessage: error ? scrub(error.message).slice(0, 300) : null,
    };
    records.push(record);
    const d = dir(c);
    writeOut(join(d, "meta.json"), record);
    if (rawText !== null) writeOut(join(d, "raw.txt"), rawText);
    if (result) {
      writeOut(join(d, `output.${result.ext}`), result.output);
      if (result.preview) writeOut(join(d, "preview.html"), result.preview);
      if (c.task === "ocr" && (c.isDefault || !outputs.ocr.has(c.page))) outputs.ocr.set(c.page, result.output);
      if (c.task === "html" || c.task === "math") outputs.htmlish.push(rawText);
    }
    say(`${String(c.n).padStart(3)} ${c.task.padEnd(9)} ${(record.page ?? "-").padEnd(8)} ${c.model.id.padEnd(30)} ${record.ok ? "ok  " : "FAIL"} ${String(record.status ?? "-").padEnd(4)} ${(record.errorCode ?? record.finishReason ?? "").padEnd(24)} ${record.latencyMs} ms  math ${record.mathValid}/${record.mathTotal}  spent $${(spent / 1e6).toFixed(4)}`);
  }

  const quotaAfter = await quota();
  const pagesInfo = Object.fromEntries(Object.entries(images).map(([k, v]) => [k, { bytes: v.bytes, width: v.width, height: v.height, dpi: v.dpi, why: pageSpecs.get(k.split(":")[0]).why }]));
  const report = lib.buildReport({ generatedAt: new Date().toISOString(), records, quotaBefore, quotaAfter, budgetMicrodollars: args.budgetMicrodollars, spentMicro: spent, stoppedByBudget: skipped, menus, pages: pagesInfo, notes });
  writeOut(join(out, "report.json"), report.json);
  writeOut(join(out, "report.md"), report.markdown);
  writeOut(join(out, "index.html"), indexHtml(lib, out, records, images));
  say(`\nWrote ${join(out, "report.md")}, report.json and index.html. Spent about $${(spent / 1e6).toFixed(4)}; skipped for budget: ${skipped}.`);
  KEY = null;
}

/** Page image next to every model's rendered output, per task. */
function indexHtml(lib, out, records, images) {
  const esc = lib.htmlEscape;
  const parts = ["<!doctype html><html><head><meta charset=\"utf-8\"><title>Live evaluation</title><style>body{font:14px system-ui,sans-serif;margin:1rem}table{border-collapse:collapse}td{vertical-align:top;border:1px solid #ccc;padding:4px}img{width:420px}iframe{width:420px;height:560px;border:0}pre{white-space:pre-wrap;max-width:420px;max-height:560px;overflow:auto}.bad{background:#fee}</style></head><body><h1>Live evaluation</h1><p>Previews are the client's own renderer (TeX and MathML as the app shows them), in sandboxed frames.</p>"];
  for (const task of ["ocr", "html", "math"]) {
    const rs = records.filter((r) => r.task === task);
    if (!rs.length) continue;
    const models = [...new Set(rs.map((r) => r.model))];
    parts.push(`<h2>${task}</h2><table><tr><th>page</th>${models.map((m) => `<th>${esc(m)}</th>`).join("")}</tr>`);
    for (const page of [...new Set(rs.map((r) => r.page))]) {
      const img = images[`${page}:${task === "math" ? "math" : "std"}`];
      parts.push(`<tr><td><b>${esc(page)}</b><br><img src="${esc(relative(out, img.file))}" alt="page ${esc(page)}"></td>`);
      for (const m of models) {
        const r = rs.find((x) => x.page === page && x.model === m);
        const preview = join(out, "calls", task, page, m, "preview.html");
        const caption = r ? `${r.ok ? "ok" : `FAIL ${esc(r.errorCode ?? "")}`}, ${r.latencyMs} ms, math ${r.mathValid}/${r.mathTotal}` : "not run";
        parts.push(`<td class="${r?.ok ? "" : "bad"}">${caption}<br>${r?.ok && existsSync(preview) ? `<iframe sandbox="" srcdoc="${esc(readFileSync(preview, "utf8"))}"></iframe>` : ""}</td>`);
      }
      parts.push("</tr>");
    }
    parts.push("</table>");
  }
  for (const task of ["summary", "translate", "repair"]) {
    const rs = records.filter((r) => r.task === task);
    if (!rs.length) continue;
    parts.push(`<h2>${task}</h2><table><tr><th>model</th><th>unit</th><th>result</th><th>output</th></tr>`);
    for (const r of rs) {
      const file = join(out, "calls", task, r.page ?? "text", r.model, task === "repair" ? "output.json" : "output.txt");
      parts.push(`<tr class="${r.ok ? "" : "bad"}"><td>${esc(r.model)}</td><td>${esc(r.page ?? "")}</td><td>${r.ok ? "ok" : `FAIL ${esc(r.errorCode ?? "")}`}<br>${r.latencyMs} ms<br><pre>${esc(JSON.stringify(r.quality, null, 1).slice(0, 800))}</pre></td><td><pre>${existsSync(file) ? esc(readFileSync(file, "utf8")) : ""}</pre></td></tr>`);
    }
    parts.push("</table>");
  }
  parts.push("</body></html>");
  return parts.join("\n");
}

await main();
