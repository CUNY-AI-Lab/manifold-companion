import { Hono } from "hono";
import { E } from "../errors";
import { searchTexts } from "../search";
import type { AppEnv } from "../app";

export const searchRoutes = new Hono<AppEnv>();

// Scoped to the caller's own projects by the membership join inside searchTexts.
searchRoutes.get("/", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (q.length < 2) throw E.badRequest("Query must be at least 2 characters.");
  if (q.length > 200) throw E.badRequest("Query is too long (max 200 characters).");
  const { hits, backend } = await searchTexts(c.env, c.get("principal").subject, q);
  return c.json({ results: hits, backend });
});
