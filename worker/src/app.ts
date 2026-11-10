import { Hono } from "hono";
import { correlationFromHeaders, type CailCorrelation } from "@cuny-ai-lab/cail-log";
import { BASE_PATH, canonicalOrigin, type Env } from "./env";
import { AppError, E, errorResponse } from "./errors";
import { authenticate, type Principal } from "./identity";
import { isMutation, originAllowed } from "./csrf";
import { withSecurityHeaders } from "./security";
import { checkConfigurationReadiness } from "./readiness";
import { sessionRoutes } from "./routes/session";
import { projectRoutes } from "./routes/projects";
import { inviteRoutes } from "./routes/invites";
import { textRoutes } from "./routes/texts";
import { searchRoutes } from "./routes/search";
import { uploadRoutes } from "./routes/uploads";
import { taskRoutes } from "./routes/tasks";
import { modelRoutes } from "./routes/models";

export interface AppVariables {
  requestId: string;
  correlation: CailCorrelation;
  principal: Principal;
}
export type AppEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<AppEnv>();

// 1. Request id, canonical origin, security headers on the way out.
app.use("*", async (c, next) => {
  const correlation = correlationFromHeaders(c.req.raw);
  c.set("correlation", correlation);
  c.set("requestId", correlation.request_id);
  const url = new URL(c.req.url);
  if (url.origin !== canonicalOrigin(c.env)) {
    // Not the canonical origin (workers.dev, preview, a stray route): this
    // Worker does not exist there.
    c.res = errorResponse(E.notFound(), correlation.request_id);
  } else {
    await next();
  }
  c.res = withSecurityHeaders(c.res, correlation.request_id, url.pathname);
});

app.get("/health/live", (c) => c.json({ status: "alive" }));

// The verdict is public (Doorway's release probe is unauthenticated); the
// reasons are not, and go to the ManifoldCompanionReadiness RPC instead.
app.get("/health/ready", async (c) => {
  const result = await checkConfigurationReadiness(c.env);
  const version = c.env.CF_VERSION_METADATA?.id ?? null;
  return result.ok ? c.json({ ok: true, status: "ready", version }) : c.json({ ok: false, status: "not_ready", version }, 503);
});

const api = new Hono<AppEnv>();

// 2. CSRF before authentication: a cross-origin write learns nothing about
//    whether it was signed in.
api.use("*", async (c, next) => {
  if (isMutation(c.req.method) && !originAllowed(c.req.raw, c.env)) {
    throw new AppError({ code: "origin_mismatch", message: "Cross-origin requests are not allowed.", status: 403 });
  }
  await next();
});

// 3. Identity: both Doorway legs, config first.
api.use("*", async (c, next) => {
  const auth = await authenticate(c.req.raw, c.env);
  if (!auth.ok) return auth.response;
  c.set("principal", auth.principal);
  // First sight of a subject creates its (empty) profile. Idempotent, one cheap statement.
  await c.env.DB.prepare("INSERT OR IGNORE INTO profiles (subject) VALUES (?1)").bind(auth.principal.subject).run();
  await next();
});

api.route("/", sessionRoutes);
api.route("/projects", projectRoutes);
api.route("/invites", inviteRoutes);
api.route("/texts", textRoutes);
api.route("/texts", uploadRoutes);
api.route("/texts", taskRoutes);
api.route("/", modelRoutes);
api.route("/search", searchRoutes);
api.all("*", (c) => errorResponse(E.notFound("No such API route."), c.get("requestId")));

app.route(`${BASE_PATH}/api`, api);

// 4. The built SPA, served under the mount. Asset misses on extension-less
//    paths fall back to index.html so client-side routes survive a reload.
app.all("*", async (c) => {
  const url = new URL(c.req.url);
  if (url.pathname === BASE_PATH) return c.redirect(`${BASE_PATH}/`, 301);
  if (!url.pathname.startsWith(`${BASE_PATH}/`)) return c.notFound();
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return errorResponse(new AppError({ code: "method_not_allowed", message: "Method not allowed.", status: 405 }), c.get("requestId"));
  const assetUrl = new URL(url);
  assetUrl.pathname = url.pathname.slice(BASE_PATH.length) || "/";
  const request = (u: URL) => new Request(u.toString(), { method: c.req.method, headers: c.req.raw.headers });
  let asset = await c.env.ASSETS.fetch(request(assetUrl));
  const lastSegment = assetUrl.pathname.split("/").pop() ?? "";
  if (asset.status === 404 && !lastSegment.includes(".")) {
    const index = new URL(assetUrl);
    index.pathname = "/index.html";
    asset = await c.env.ASSETS.fetch(request(index));
  }
  const location = asset.headers.get("location");
  if (asset.status >= 300 && asset.status < 400 && location?.startsWith("/") && !location.startsWith(`${BASE_PATH}/`)) {
    const headers = new Headers(asset.headers);
    headers.set("location", `${BASE_PATH}${location}`);
    return new Response(null, { status: asset.status, headers });
  }
  return asset;
});

app.notFound((c) => errorResponse(E.notFound(), c.get("requestId") ?? "unknown"));

app.onError((error, c) => {
  const requestId = c.get("requestId");
  if (error instanceof AppError) return errorResponse(error, requestId);
  // Class only, never the message, which can quote request content.
  console.error(JSON.stringify({ event: "manifold_companion.unhandled_error", request_id: requestId, error_type: error instanceof Error ? error.name : typeof error }));
  return errorResponse(new AppError({ code: "internal_error", message: "Internal server error.", status: 500 }), requestId);
});

export default app;
