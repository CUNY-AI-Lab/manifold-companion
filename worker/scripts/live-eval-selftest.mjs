#!/usr/bin/env node
// Runs scripts/live-eval.mjs end to end against a stubbed Gateway (preloaded
// fetch stub): stdin key, real Worker builders/parsers, files, report, index.
// No network for model calls and no spend. Exits non-zero on any failure.
//   node worker/scripts/live-eval-selftest.mjs [--mathbook DIR]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = import.meta.dirname;
const out = mkdtempSync(join(tmpdir(), "live-eval-selftest-"));
const log = join(out, "gateway-calls.jsonl");
const KEY = "sk-cail-SELFTESTKEYSELFTESTKEY0123456789";
const extra = process.argv.slice(2);
const stdout = execFileSync(process.execPath, ["--import", join(here, "live-eval-stub-gateway.mjs"), join(here, "live-eval.mjs"), "--out", out, "--pages", "ch7-p2,ch7-p7", "--budget-microdollars", "1500000", ...extra], { input: `${KEY}\n`, env: { ...process.env, LIVE_EVAL_SELFTEST_LOG: log }, encoding: "utf8" });
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const files = walk(out).filter((f) => !f.includes(".bundle") && !f.endsWith(".jpg") && f !== log);
check(!stdout.includes(KEY), "the key appears on stdout");
for (const f of files) check(!readFileSync(f, "utf8").includes(KEY), `the key appears in ${f}`);
const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const chats = calls.filter((c) => c.path === "/v1/chat/completions");
check(chats.length > 0 && chats.every((c) => c.bearer && !c.jwtHeader), "chat calls must carry Bearer and no JWT header");
check(new Set(chats.map((c) => c.requestId)).size === chats.length, "every chat call needs its own request id");
check(calls.filter((c) => c.path === "/v1/quota").length === 2, "quota read before and after");
const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
check(report.records.length === chats.length, "one record per call");
check(report.records.some((r) => r.task === "math" && r.errorCode === "model_output_empty"), "an empty length stop is recorded as model_output_empty");
check(report.records.some((r) => r.task === "html" && r.ok && r.quality.fence === true && r.quality.stripped.pipeline.attrs.style === 1), "fence and stripped style recorded");
check(report.records.some((r) => r.task === "html" && r.mathTotal === 4 && r.mathValid === 3), "math validity counted on HTML output (4 fragments, one broken)");
check(report.records.some((r) => r.task === "repair" && r.ok && r.quality.parses === true), "formula repair scored");
check(report.quota.deltaMicro !== null, "quota difference computed");
check(readFileSync(join(out, "report.md"), "utf8").includes("## Recommendation"), "report.md written");
check(readFileSync(join(out, "index.html"), "utf8").includes('iframe sandbox=""'), "index.html shows sandboxed previews");
if (failures.length) { console.error(`live-eval selftest FAILED:\n- ${failures.join("\n- ")}\n(output in ${out})`); process.exit(1); }
console.log(`live-eval selftest passed: ${chats.length} stubbed calls, ${files.length} files, output in ${out}`);
