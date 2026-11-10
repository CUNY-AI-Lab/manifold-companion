import { describe, expect, it } from "vitest";
import { ALICE, BOB, CAROL, addMember, api, call, createProject, invite, json } from "./helpers";
import { canonicalTestSubject } from "@cuny-ai-lab/cail-identity/testing";

const DAVE = canonicalTestSubject("dave");
const EVE = canonicalTestSubject("eve");
type Actor = "owner" | "editor" | "viewer" | "stranger";
const ACTORS: Actor[] = ["owner", "editor", "viewer", "stranger"];
const WHO: Record<Actor, string> = { owner: ALICE, editor: BOB, viewer: CAROL, stranger: DAVE };
const RANK = { stranger: 0, viewer: 1, editor: 2, owner: 3 } as const;

async function setup(): Promise<{ id: string; inviteId: string }> {
  const id = await createProject(ALICE, "Matrix");
  await addMember(ALICE, id, BOB, "editor");
  await addMember(ALICE, id, CAROL, "viewer");
  const inv = await invite(ALICE, id, "viewer");
  return { id, inviteId: inv.id };
}

interface Route {
  name: string;
  min: "viewer" | "editor" | "owner";
  ok: number;
  run: (ctx: { id: string; inviteId: string }, as: string) => Promise<Response>;
}

// Every project-scoped route this phase adds. Adding a route without adding it
// here is caught by the route-coverage test below.
const ROUTES: Route[] = [
  { name: "GET /projects/:id", min: "viewer", ok: 200, run: ({ id }, as) => call(api(`/projects/${id}`), { as }) },
  { name: "PUT /projects/:id", min: "owner", ok: 200, run: ({ id }, as) => call(api(`/projects/${id}`), { method: "PUT", as, body: { name: "Renamed" } }) },
  { name: "DELETE /projects/:id", min: "owner", ok: 200, run: ({ id }, as) => call(api(`/projects/${id}`), { method: "DELETE", as }) },
  { name: "GET /projects/:id/members", min: "viewer", ok: 200, run: ({ id }, as) => call(api(`/projects/${id}/members`), { as }) },
  { name: "DELETE /projects/:id/members/:other", min: "owner", ok: 200, run: ({ id }, as) => call(api(`/projects/${id}/members/${EVE}`), { method: "DELETE", as }) },
  { name: "POST /projects/:id/invites", min: "owner", ok: 201, run: ({ id }, as) => call(api(`/projects/${id}/invites`), { method: "POST", as, body: { role: "viewer" } }) },
  { name: "GET /projects/:id/invites", min: "owner", ok: 200, run: ({ id }, as) => call(api(`/projects/${id}/invites`), { as }) },
  { name: "DELETE /projects/:id/invites/:inviteId", min: "owner", ok: 200, run: ({ id, inviteId }, as) => call(api(`/projects/${id}/invites/${inviteId}`), { method: "DELETE", as }) },
];

describe("authorization matrix: owner / editor / viewer / stranger x every project route", () => {
  for (const route of ROUTES) {
    it(route.name, async () => {
      for (const actor of ACTORS) {
        const ctx = await setup();
        // Seed the member the owner-only removal targets.
        await addMember(ALICE, ctx.id, EVE, "viewer");
        const res = await route.run(ctx, WHO[actor]);
        if (actor === "stranger") {
          expect(res.status, `${route.name} as stranger`).toBe(404);
          expect((await json(res)).error.code).toBe("not_found");
        } else if (RANK[actor] >= RANK[route.min]) {
          expect(res.status, `${route.name} as ${actor}`).toBe(route.ok);
        } else {
          expect(res.status, `${route.name} as ${actor}`).toBe(403);
          expect((await json(res)).error.code).toBe("insufficient_role");
        }
      }
    });
  }

  it("a stranger cannot tell a missing project from someone else's", async () => {
    const { id } = await setup();
    const other = await call(api(`/projects/${id}`), { as: DAVE });
    const missing = await call(api("/projects/00000000-0000-4000-8000-000000000000"), { as: DAVE });
    const malformed = await call(api("/projects/not-an-id"), { as: DAVE });
    expect(other.status).toBe(404);
    const strip = async (r: Response) => ({ ...(await json(r)).error, requestId: undefined });
    expect(await strip(other)).toEqual(await strip(missing));
    expect(malformed.status).toBe(404);
  });

  it("denied writes change nothing", async () => {
    const { id } = await setup();
    for (const as of [CAROL, BOB, DAVE]) {
      await call(api(`/projects/${id}`), { method: "PUT", as, body: { name: "HACKED" } });
      await call(api(`/projects/${id}`), { method: "DELETE", as });
    }
    const res = await call(api(`/projects/${id}`), { as: ALICE });
    expect((await json(res)).project.name).toBe("Matrix");
  });

  it("members: leaving is allowed for non-owners, owners cannot leave or be removed", async () => {
    const { id } = await setup();
    expect((await call(api(`/projects/${id}/members/${ALICE}`), { method: "DELETE", as: ALICE })).status).toBe(409);
    expect((await call(api(`/projects/${id}/members/${ALICE}`), { method: "DELETE", as: BOB })).status).toBe(403);
    expect((await call(api(`/projects/${id}/members/${CAROL}`), { method: "DELETE", as: BOB })).status).toBe(403);
    expect((await call(api(`/projects/${id}/members/${BOB}`), { method: "DELETE", as: BOB })).status).toBe(200);
    expect((await call(api(`/projects/${id}`), { as: BOB })).status).toBe(404);
    expect((await call(api(`/projects/${id}/members/${CAROL}`), { method: "DELETE", as: ALICE })).status).toBe(200);
    expect((await call(api(`/projects/${id}/members/${canonicalTestSubject("nobody")}`), { method: "DELETE", as: ALICE })).status).toBe(404);
    expect((await call(api(`/projects/${id}/members/not-a-subject`), { method: "DELETE", as: ALICE })).status).toBe(404);
  });

  it("member listing shows roles and self-set display names, flags me, and has no email", async () => {
    const { id } = await setup();
    await call(api("/profile"), { method: "PUT", as: BOB, body: { display_name: "Bob B." } });
    const res = await call(api(`/projects/${id}/members`), { as: BOB });
    const { members } = await json(res);
    expect(members.map((m: any) => [m.role, m.me])).toEqual([["owner", false], ["editor", true], ["viewer", false]]);
    expect(members.find((m: any) => m.subject === BOB).display_name).toBe("Bob B.");
    expect(JSON.stringify(members)).not.toMatch(/email|@/);
  });

  it("project listing is scoped to membership", async () => {
    const mine = await createProject(ALICE, "Alice only");
    const shared = await createProject(BOB, "Bob shared");
    await addMember(BOB, shared, ALICE, "viewer");
    const { projects } = await json(await call(api("/projects"), { as: ALICE }));
    const ids = projects.map((p: any) => p.id);
    expect(ids).toContain(mine);
    expect(ids).toContain(shared);
    const bobs = (await json(await call(api("/projects"), { as: BOB }))).projects.map((p: any) => p.id);
    expect(bobs).not.toContain(mine);
    expect((await json(await call(api("/projects"), { as: DAVE }))).projects).toEqual([]);
    expect(projects.find((p: any) => p.id === shared).role).toBe("viewer");
  });

  it("profile routes only ever touch the caller's own profile", async () => {
    await call(api("/profile"), { method: "PUT", as: ALICE, body: { display_name: "Alice" } });
    await call(api("/profile"), { method: "PUT", as: BOB, body: { display_name: "Bob", theme_preference: "dark", onboarded: true } });
    expect((await json(await call(api("/session"), { as: ALICE }))).profile.display_name).toBe("Alice");
    const bob = (await json(await call(api("/session"), { as: BOB }))).profile;
    expect(bob).toEqual({ display_name: "Bob", theme_preference: "dark", onboarded: true });
    // Attempts to name another subject in the body are ignored: there is no such field.
    await call(api("/profile"), { method: "PUT", as: ALICE, body: { display_name: "A2", subject: BOB } });
    expect((await json(await call(api("/session"), { as: BOB }))).profile.display_name).toBe("Bob");
  });

  it("profile validation", async () => {
    for (const body of [{}, { display_name: 5 }, { display_name: "x".repeat(81) }, { display_name: "<b>" }, { theme_preference: "neon" }, { onboarded: "yes" }]) {
      expect((await call(api("/profile"), { method: "PUT", body })).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("project input validation", async () => {
    for (const body of [{}, { name: "" }, { name: "x".repeat(201) }, { name: "ok", project_type: "x" }, { name: "ok", default_language: "English!" }]) {
      expect((await call(api("/projects"), { method: "POST", body })).status, JSON.stringify(body)).toBe(400);
    }
    const id = await createProject(ALICE, "P", { description: "d", project_type: "pdf_to_html", default_language: "pt-BR" });
    const { project } = await json(await call(api(`/projects/${id}`), { as: ALICE }));
    expect(project).toMatchObject({ description: "d", project_type: "pdf_to_html", default_language: "pt-BR", role: "owner", text_count: 0, member_count: 1 });
    expect((await call(api(`/projects/${id}`), { method: "PUT", body: { name: "" } })).status).toBe(400);
    const cleared = await call(api(`/projects/${id}`), { method: "PUT", body: { description: null } });
    expect((await json(cleared)).project.description).toBeNull();
  });

  it("route coverage: the matrix lists every project-scoped route the app exposes", async () => {
    const { default: app } = await import("../src/app");
    const registered = app.routes
      .filter((r) => r.path.includes("/projects/:id") && r.method !== "ALL")
      .map((r) => `${r.method} ${r.path.replace("/manifold-companion/api", "")}`);
    const covered = new Set(ROUTES.map((r) => r.name.replace(/:other|:inviteId/g, (m) => (m === ":other" ? ":subject" : m))));
    for (const r of registered) {
      const normalized = r.replace("/members/:subject", "/members/:subject");
      expect(covered.has(normalized), `route ${r} is not in the authorization matrix`).toBe(true);
    }
  });
});
