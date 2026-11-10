import { WorkerEntrypoint } from "cloudflare:workers";
import app from "./app";
import type { Env } from "./env";
import { readinessResult, type ReadinessResult } from "./readiness";
import { runRetentionSweep } from "./retention";

export type { ReadinessResult } from "./readiness";

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  // Daily retention sweep (wrangler.jsonc `triggers.crons`).
  scheduled: (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(runRetentionSweep(env).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;

/** Doorway's release probe, over a service binding. */
export class ManifoldCompanionReadiness extends WorkerEntrypoint<Env> {
  async getReadiness(): Promise<ReadinessResult> {
    return readinessResult(this.env);
  }
}
