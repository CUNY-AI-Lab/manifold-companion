// Catalog rows in the Gateway's shape (see LanGames test/catalog.fixture.json, read from the live catalog).
// Fabricated ids on purpose: the code under test must read capabilities, never names.
const row = (id: string, order: number, recommended: boolean, capabilities: string[], extra: Record<string, unknown> = {}) => ({
  id, object: "model", recommended, tier: recommended ? "recommended" : "advanced", order, status: "active", modality: "text",
  provider: "workers-ai", upstream_model: id, pricing_known: "catalog", streaming: true, sunset: null, capabilities,
  context_length: 128000, registry_url: null, name: id.toUpperCase(), task: "Text Generation", ...extra,
});

export const CATALOG = {
  object: "list",
  data: [
    row("text-only-fast", 1, true, ["text-generation", "function-calling"]),
    row("vision-plain", 2, true, ["text-generation", "vision"]),
    row("vision-thinker", 3, true, ["text-generation", "vision", "reasoning"]),
    row("text-thinker", 4, false, ["text-generation", "reasoning"]),
    row("vision-thinker-advanced", 5, false, ["text-generation", "vision", "reasoning"]),
    row("speech", 6, true, ["automatic-speech-recognition"]),
    row("retired-vision", 7, false, ["text-generation", "vision"], { status: "retiring" }),
  ],
};
