import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach } from "vitest";

// Applies every migration to the main test database before each test file, the
// same way `wrangler d1 migrations apply` does (tracked in d1_migrations).
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Tests share one database per file, so start each from empty. Deleting
// profiles exercises the real cascade; the FTS table is cleared by trigger.
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM profiles").run();
  await env.DB.prepare("DELETE FROM text_fts").run();
  for (;;) {
    const page = await env.FILES.list({ limit: 1000 });
    if (page.objects.length === 0) break;
    await env.FILES.delete(page.objects.map((o) => o.key));
  }
});
