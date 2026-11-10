import { Hono } from "hono";
import { gatewayClient, freshCorrelation, gatewayError } from "../gateway";
import { defaultFor, loadCatalog, menuFor, type Task } from "../models";
import type { AppEnv } from "../app";

export const modelRoutes = new Hono<AppEnv>();

const TASKS: Task[] = ["ocr", "html_page", "html_math", "text"];

// The menus a person may pick from, per task, straight from the live Gateway
// catalog (no list is kept here). Fails closed with 503 catalog_unavailable.
modelRoutes.get("/models", async (c) => {
  const list = await loadCatalog(gatewayClient(c.env, freshCorrelation(c.req.raw)), Date.now(), c.req.raw.signal);
  const tasks: Record<string, unknown> = {};
  for (const task of TASKS) {
    const menu = menuFor(task, list);
    tasks[task] = { default: defaultFor(task, menu, c.env)?.id ?? null, models: menu };
  }
  return c.json({ tasks });
});

// Gateway /quota passed through untouched (microdollars: limit, estimated_used, ...).
// The app keeps no ledger. A Gateway 503 quota_unavailable is passed on as such.
modelRoutes.get("/quota", async (c) => {
  try {
    const snapshot = await gatewayClient(c.env, freshCorrelation(c.req.raw)).getQuota(c.get("principal").credential, { signal: c.req.raw.signal });
    return c.json({ quota: snapshot });
  } catch (error) {
    throw gatewayError(error, undefined, c.req.raw.signal);
  }
});
