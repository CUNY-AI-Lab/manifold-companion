# Model policy: defaults and menus

Decided 2026-11-10 by the owner from a live evaluation the same day. Code: `src/models.ts` (`BUILTIN_POLICY`, `policyFrom`, `offeredMenu`, `defaultFor`, `thinksOnMath`). Configuration: the `MODEL_*` and `MATH_*` vars in `wrangler.jsonc`. Tests: `test/model-policy.test.ts`.

## The policy

| Task | Default | Menu shown | Notes |
|---|---|---|---|
| OCR (image to Markdown) | `deepseek-v4.1-flash-1017` | every vision model, measured ones first (DeepSeek, Mistral Large 3, Qwen 3.8, Gemma 4), then catalog order | thinking off (switches sent) |
| PDF page to HTML | `deepseek-v4.1-flash-1017` | as OCR | thinking off |
| Math / tables page | `magistral-small-2509` | **only** Magistral Small, DeepSeek Flash, Qwen 3.8 (the models that passed) | Magistral thinks; DeepSeek gets the thinking-off switches on this path too |
| Summary, translation, formula repair | `deepseek-v4.1-flash-1017` | every text model, DeepSeek, gpt-oss-120b, Mistral Large 3 first | thinking off |

Never offered in any menu or chosen as a default: Kimi (`kimi-*`, the owner's call: overkill for this work). Never offered for math: Gemma (`gemma-*`). Both remain reachable by typing the model id ("Another model (type its id)" in the picker). A typed id is checked against the task's capability menu (vision for page tasks, vision plus reasoning for math when the catalog has any) before any spend, so a typo or a model without vision gets `400 model_not_allowed`.

The catalog still decides what exists and what each model can do. The policy only orders and narrows:
- A model the policy names but the catalog no longer lists is skipped, so a retired or renamed model falls to the next one in the order.
- If none of the math models is left, the math menu falls back to the catalog rule: vision + reasoning models minus hidden ones, in the Gateway's order (on the 2026-11-10 catalog that is `glm-5.3-flash` alone).
- If a task's order has no model left, the default is the Gateway's top-ranked offered model.

`GET /api/models` returns per task `{ default, models, typeable }`; `typeable` counts the capable models not on the menu.

## Changing it

All lists are comma-separated model ids; a trailing `*` matches a prefix. An unset var uses the built-in value (identical to `wrangler.jsonc` today); an empty var means an empty list. Malformed entries are dropped.

| Var | Meaning |
|---|---|
| `MODEL_ORDER_VISION` | Default preference for OCR and page HTML; also the order of the top of those menus |
| `MODEL_ORDER_MATH` | Default preference for math pages |
| `MATH_MODELS_OFFERED` | The only models the math menu shows (when the catalog has any of them) |
| `MODEL_ORDER_TEXT` | Default preference for summary, translation, repair |
| `MODELS_HIDDEN` | Never offered or defaulted, any task (still typeable) |
| `MATH_MODELS_HIDDEN` | Never offered or defaulted for math (still typeable) |
| `MATH_THINKING_OFF` | Reasoning models that get `enable_thinking: false` / `reasoning_effort: "low"` on the math path too |
| `DEFAULT_VISION_MODEL`, `DEFAULT_MATH_MODEL`, `DEFAULT_TEXT_MODEL` | Pin first place without editing the order |

Edit `wrangler.jsonc` and redeploy, or set the var in the dashboard. Keep `BUILTIN_POLICY` in `src/models.ts` in step when the evidence changes, and add the new run below.

## Evidence (live run, 2026-11-10)

82 calls through the real Gateway with the Worker's own request builders, parsers, deadlines and sanitizer (`scripts/live-eval.mjs`, section 6.4 of HANDOFF). Pages from the precalculus textbook: Chapter 7 identities (pp. 2, 7, 8, 15) and Chapter 1 (p. 19, twelve In/Out tables; p. 35, piecewise graphs and cases). Standard pages at 144 dpi, math pages at 216 dpi, JPEG q88. Spend 248,608 µ$ estimated from catalog prices, 255,388 µ$ by the Gateway quota delta. "Math" counts formulas that KaTeX renders without error.

| Task | Model | OK | Median s | Cost µ$ | Math | Failures |
|---|---|---|---|---|---|---|
| OCR | deepseek-v4.1-flash-1017 | 3/3 | 4.9 | 3,316 | 77/77 | |
| OCR | mistral-large-3-675b-instruct | 3/3 | 3.6 | 6,790 | 44/44 | |
| OCR | gemma-4-26b-a4b-it | 3/3 | 14.0 | 773 | 92/92 | |
| OCR | qwen3.8-27b | 3/3 | 22.1 | 9,233 | 92/92 | |
| Page HTML | deepseek-v4.1-flash-1017 | 4/4 | 6.3 | 8,287 | 96/96 | |
| Page HTML | mistral-large-3-675b-instruct | 4/4 | 5.1 | 13,708 | 99/99 | |
| Page HTML | gemma-4-26b-a4b-it | 4/4 | 19.7 | 2,140 | 98/98 | |
| Page HTML | qwen3.8-27b | 4/4 | 55.0 | 22,815 | 101/101 | |
| Math | magistral-small-2509 | 6/6 | 10.6 | 21,981 | 135/135 | |
| Math | deepseek-v4.1-flash-1017 | 5/6 | 11.1 | 40,274 | 160/160 | 1 `model_output_empty` |
| Math | qwen3.8-27b | 5/6 | 62.5 | 51,441 | 116/116 | 1 `upstream_timeout` |
| Math | glm-5.3-flash | 4/6 | 67.8 | 12,384 | 125/125 | 2 deadline |
| Math | gemma-4-26b-a4b-it | 1/6 | 88.1 | 7,178 | 44/44 | 4 deadline, 1 empty |

Kimi was not run (excluded by the owner before the run). Text tasks (summary, translation, repair) all succeeded for every model; DeepSeek was among the fastest at low cost, which with "one default model for most work" made it the text default.

Why these choices:
- **DeepSeek Flash for standard pages:** every OCR and page-HTML call succeeded at about 5 to 6 s per page, at mid-range cost. Gemma is cheaper but three times slower; Mistral Large 3 is as fast but costs more and wrote fewer formulas as TeX on the same pages.
- **Magistral Small for math:** the only model with 6/6 math pages, the fastest median, and the cheapest of the models that passed.
- **DeepSeek thinking off on math pages.** Its one failure was ch1-p19 (twelve tables): with thinking on it spent the whole 14,000-token budget (6,000 task + 8,000 headroom) reasoning in 71 s, `finish_reason: "length"`, nothing written. The same page on the standard path (thinking off, 144 dpi) took 9 s, 1,888 tokens, every table cell correct. On ch1-p35 with thinking on it used 9,360 tokens in 51 s. A larger budget would not help: the call was already at 71 s of a 150 s deadline, and any successful longer reasoning would be slower still. So DeepSeek, when chosen for math, runs with the switches off (10,000 tokens: 6,000 + 4,000). **Not yet measured at 216 dpi on the math path**; verify with `--tasks math --models deepseek-v4.1-flash-1017` (6 calls, about $0.02).
- **Magistral's 63 s on ch1-p19** is output volume, not reasoning: 3,437 completion tokens, 11,742 characters of HTML (twelve full tables), the largest output of the run. The other five pages took 6 to 15 s.

Formula fidelity was checked by hand on all six math pages, page image against output. Neither Magistral nor DeepSeek got a sign, exponent, coefficient or table value wrong on any of them; all 72 table cells on ch1-p19 are correct for both (DeepSeek's from the standard path). The differences are structural:

| Page | Magistral Small | DeepSeek Flash |
|---|---|---|
| ch7-p2 (identities, cases) | identities correct; keeps each case's working together | identities correct; interleaves the two-column case solution row by row |
| ch7-p7 | faithful; keeps the running header; inline math | faithful; display math; closer reading order |
| ch7-p8 (42 exercises) | identical to DeepSeek, all correct | all correct |
| ch7-p15 (worked example) | all values correct; adds "or" between the columns of rows 2 and 3 (printed only in row 1) | all values correct; flattens the three-column solution into nine separate lines, losing which steps belong together |
| ch1-p19 (12 tables) | all cells correct; the table label (i., ii.) sits in an extra empty first column of each table; keeps the running header | (standard path) all cells correct; pairs tables i-iii and iv-vi into two six-column tables |
| ch1-p35 (graphs, cases) | cases 31 to 36 correct, but in an `<ol>` with no `start`, so they render as 1 to 6; graphs 25 to 30 get empty captions | cases correct and numbered 31 to 36; graph descriptions wrong in 4 of 6 (25: a segment starts at (0,-2), printed (-1,-2); 26: (-1,5) for (-2,5) and (0,-3)-(4,-3) for (1,-3)-(5,-3); 29: misdescribes the left branch as a ray with an open circle at the origin; 30: the ray ends at (0,-1), printed (-1,-1)) |

The DeepSeek graph descriptions matter because they become figure text a reader relies on; neither model invented a formula from a graph, as the prompt forbids.

## Re-verifying

```bash
node worker/scripts/live-eval.mjs --dry-run                       # plan and worst-case cost, no key
pbpaste | node worker/scripts/live-eval.mjs --tasks math --models magistral-small-2509,deepseek-v4.1-flash-1017
node worker/scripts/live-eval.mjs --rerender --out <dir>          # rebuild previews and index.html from report.json, no network
```

The harness uses the same policy (`BUILTIN_POLICY`) to choose defaults and the thinking switches, so a run measures what the Worker would send.
