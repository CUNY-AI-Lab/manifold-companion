import { WorkerEntrypoint } from "cloudflare:workers";
import app from "./app";
import type { Env } from "./env";
import { readinessResult, type ReadinessResult } from "./readiness";
import { runRetentionSweep } from "./retention";
import { logger } from "./logging";

export type { ReadinessResult } from "./readiness";

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  // Daily retention sweep (wrangler.jsonc `triggers.crons`).
  scheduled: (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    const started = Date.now();
    ctx.waitUntil(
      runRetentionSweep(env).then(
        (r) => {
          const counts = `w${r.warned}_d${r.deleted}_f${r.failed}_c${r.cleaned}`;
          logger(env).emit(r.failed > 0 ? "retention.sweep_failed" : "retention.sweep", { error_type: counts, duration_ms: Date.now() - started });
        },
        () => logger(env).emit("retention.sweep_failed", { error_type: "sweep_error", duration_ms: Date.now() - started }),
      ),
    );
  },
} satisfies ExportedHandler<Env>;

/** Doorway's release probe, over a service binding. */
export class ManifoldCompanionReadiness extends WorkerEntrypoint<Env> {
  async getReadiness(): Promise<ReadinessResult> {
    return readinessResult(this.env);
  }
}
