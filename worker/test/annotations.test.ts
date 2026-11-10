import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { canonicalTestSubject } from "@cuny-ai-lab/cail-identity/testing";
import { ALICE, BOB, CAROL, addMember, api, call, createProject, createText, invite, json, redeem, seedPage } from "./helpers";
import { MAX_NOTIFICATIONS_PER_PERSON, notify } from "../src/notify";

const DAVE = canonicalTestSubject("dave");
const post = (path: string, body: unknown, as = ALICE) => call(api(path), { method: "POST", body, as });
const notes = async (subject: string) => (await env.DB.prepare("SELECT type, title, body, link FROM notifications WHERE subject = ? ORDER BY created_at, rowid").bind(subject).all<any>()).results;

async function team() {
  const pid = await createProject(ALICE, "Team");
  await addMember(ALICE, pid, BOB, "editor");
  await addMember(ALICE, pid, CAROL, "viewer");
  await call(api("/profile"), { method: "PUT", as: BOB, body: { display_name: "Bob" } });
  const tid = await createText(ALICE, pid, "Chapter");
  await env.DB.prepare("DELETE FROM notifications").run();
  return { pid, tid };
}
const comment = async (tid: string, as = ALICE, extra: Record<string, unknown> = {}) => {
  const res = await post(`/texts/${tid}/annotations`, { anchor_type: "range", anchor_data: { quote: "ook", prefix: "L", suffix: " here", start: 1, end: 4 }, body: "Look here", ...extra }, as);
  return { res, id: res.status === 201 ? ((await json(res)).annotation.id as string) : "" };
};

describe("annotations follow the legacy roles", () => {
  it("viewers read and see author names; editors create, reply and resolve; viewers cannot", async () => {
    const { tid } = await team();
    const { id } = await comment(tid, BOB);
    const list = await json(await call(api(`/texts/${tid}/annotations`), { as: CAROL }));
    expect(list.annotations).toHaveLength(1);
    expect(list.annotations[0]).toMatchObject({ body: "Look here", author_name: "Bob", anchor_data: { quote: "ook", prefix: "L", suffix: " here", start: 1, end: 4 }, mine: false, resolved: false, reply_count: 0 });
    expect(JSON.stringify(list)).not.toMatch(/email|@/);
    expect((await comment(tid, CAROL)).res.status).toBe(403);
    expect((await post(`/texts/${tid}/annotations/${id}/replies`, { body: "r" }, CAROL)).status).toBe(403);
    expect((await post(`/texts/${tid}/annotations/${id}/resolve`, {}, CAROL)).status).toBe(403);
    expect((await post(`/texts/${tid}/annotations/${id}/resolve`, {}, ALICE)).status).toBe(200);
    expect((await json(await call(api(`/texts/${tid}/annotations`)))).annotations).toHaveLength(0);
    expect((await json(await call(api(`/texts/${tid}/annotations?resolved=1`)))).annotations[0]).toMatchObject({ resolved: true, resolved_by: ALICE });
  });

  it("only the author edits; the author or the project owner deletes (with replies)", async () => {
    const { tid } = await team();
    const { id } = await comment(tid, BOB);
    await post(`/texts/${tid}/annotations/${id}/replies`, { body: "reply" }, ALICE);
    expect((await call(api(`/texts/${tid}/annotations/${id}`), { method: "PUT", as: ALICE, body: { body: "hijack" } })).status).toBe(403);
    expect((await call(api(`/texts/${tid}/annotations/${id}`), { method: "PUT", as: BOB, body: { body: "edited" } })).status).toBe(200);
    const { id: aliceNote } = await comment(tid, ALICE);
    expect((await call(api(`/texts/${tid}/annotations/${aliceNote}`), { method: "DELETE", as: BOB })).status).toBe(403);
    expect((await call(api(`/texts/${tid}/annotations/${id}`), { method: "DELETE", as: ALICE })).status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM annotations WHERE text_id = ? AND id != ?").bind(tid, aliceNote).first<any>()).n).toBe(0);
  });

  // Regression (legacy bug): parent_id was taken on trust, so a comment could be threaded
  // under an annotation of another text, even of another project.
  it("a reply's parent must be a comment on the same text; a reply to a reply joins its root", async () => {
    const { pid, tid } = await team();
    const other = await createText(ALICE, pid, "Other");
    const elsewhere = await createProject(DAVE);
    const daveText = await createText(DAVE, elsewhere);
    const { id: foreign } = await comment(daveText, DAVE);
    const { id: otherTextNote } = await comment(other, ALICE);
    for (const parent of [foreign, otherTextNote, "00000000-0000-4000-8000-000000000000", "nope"]) {
      const res = await post(`/texts/${tid}/annotations`, { anchor_type: "global", body: "x", parent_id: parent });
      expect(res.status, parent).toBe(404);
    }
    expect((await post(`/texts/${tid}/annotations/${otherTextNote}/replies`, { body: "x" })).status).toBe(404);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM annotations WHERE text_id = ?").bind(tid).first<any>()).n).toBe(0);
    const { id: root } = await comment(tid);
    const r1 = (await json(await post(`/texts/${tid}/annotations/${root}/replies`, { body: "r1" }))).annotation;
    const r2 = (await json(await post(`/texts/${tid}/annotations/${r1.id}/replies`, { body: "r2" }))).annotation;
    expect(r2.parent_id).toBe(root);
    const thread = await json(await call(api(`/texts/${tid}/annotations/${root}`)));
    expect(thread.replies.map((r: any) => r.body)).toEqual(["r1", "r2"]);
  });

  it("bounds the body and anchor_data", async () => {
    const { tid } = await team();
    expect((await comment(tid, ALICE, { body: "x".repeat(10_001) })).res.status).toBe(400);
    expect((await comment(tid, ALICE, { body: "   " })).res.status).toBe(400);
    const big = await comment(tid, ALICE, { anchor_type: "point", anchor_data: { selector: "x".repeat(5000) } });
    expect(big.res.status).toBe(413);
    expect((await json(big.res)).error.code).toBe("anchor_too_large");
    expect((await comment(tid, ALICE, { anchor_type: "evil" })).res.status).toBe(400);
  });
});

describe("range anchors are validated as data, never stored as given", () => {
  it("only the known keys, types and bounds; the page must belong to the text", async () => {
    const { pid, tid } = await team();
    const ok = await comment(tid, ALICE, { anchor_data: { quote: "<img src=x onerror=alert(1)>", prefix: "", suffix: "", start: 0, end: 28 } });
    expect(ok.res.status).toBe(201);
    expect((await json(await call(api(`/texts/${tid}/annotations/${ok.id}`)))).annotation.anchor_data.quote).toBe("<img src=x onerror=alert(1)>"); // stored as text; shown as text
    const other = await createText(ALICE, pid, "Other");
    const page = { id: await seedPage(other) };
    const bad = [
      { start: 1, end: 4 }, // no quote
      { quote: "   ", start: 0, end: 3 },
      { quote: "x".repeat(1001), start: 0, end: 1001 },
      { quote: "x", prefix: "p".repeat(65), start: 0, end: 1 },
      { quote: "x", start: 5, end: 2 },
      { quote: "x", start: -1, end: 1 },
      { quote: "x", start: 0.5, end: 1 },
      { quote: "x", start: 0, end: 1, page_id: "nope" },
      { quote: "x", start: 0, end: 1, page_id: page!.id }, // a page of another text
      { quote: "x", start: 0, end: 1, html: "<b>" }, // unknown key
      ["quote"],
      "quote",
    ];
    for (const anchor_data of bad) {
      const r = await comment(tid, ALICE, { anchor_data });
      expect(r.res.status, JSON.stringify(anchor_data).slice(0, 60)).toBe(400);
      expect((await json(r.res)).error.code).toBe("anchor_invalid");
    }
  });
});

describe("mentions are limited to project members", () => {
  it("a non-member, a removed member or a malformed id is refused and nothing is stored", async () => {
    const { pid, tid } = await team();
    await createProject(DAVE); // Dave exists, but is not a member of Team
    for (const mentions of [[DAVE], ["not-a-subject"], [BOB, DAVE]]) {
      const { res } = await comment(tid, ALICE, { mentions });
      expect(res.status, JSON.stringify(mentions)).toBe(400);
    }
    await call(api(`/projects/${pid}/members/${CAROL}`), { method: "DELETE", as: ALICE });
    expect((await json((await comment(tid, ALICE, { mentions: [CAROL] })).res)).error.code).toBe("mention_not_member");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM annotations").first<any>()).n).toBe(0);
    expect(await notes(DAVE)).toEqual([]);
  });

  it("the member list for autocomplete is members only, with display names and no email", async () => {
    const { tid } = await team();
    const { users } = await json(await call(api(`/texts/${tid}/mentions`), { as: CAROL }));
    expect(users.map((u: any) => u.subject).sort()).toEqual([ALICE, BOB, CAROL].sort());
    expect(JSON.stringify(users)).not.toMatch(/email|@/);
  });
});

describe("in-app notifications", () => {
  it("mentions and replies notify the right people (never the actor), linking to the comments", async () => {
    const { tid } = await team();
    const { id } = await comment(tid, ALICE, { mentions: [BOB, ALICE] });
    expect(await notes(ALICE)).toEqual([]);
    expect(await notes(BOB)).toEqual([{ type: "comment_mention", title: 'Someone mentioned you on "Chapter"', body: "Look here", link: `/texts/${tid}?tab=review&annotations=1` }]);
    await post(`/texts/${tid}/annotations/${id}/replies`, { body: "Agreed" }, BOB);
    expect((await notes(ALICE)).map((n) => [n.type, n.title])).toEqual([["comment_reply", 'Bob replied to your comment on "Chapter"']]);
    await post(`/texts/${tid}/annotations/${id}/replies`, { body: "self" }, ALICE);
    expect(await notes(ALICE)).toHaveLength(1);
  });

  it("respects the in-app preference for each type", async () => {
    const { tid } = await team();
    expect((await call(api("/notifications/preferences"), { method: "PUT", as: BOB, body: { inapp_comment_mention: false } })).status).toBe(200);
    expect((await json(await call(api("/notifications/preferences"), { as: BOB }))).preferences).toEqual({ inapp_project_shared: true, inapp_comment_reply: true, inapp_comment_mention: false });
    await comment(tid, ALICE, { mentions: [BOB] });
    expect(await notes(BOB)).toEqual([]);
    expect((await call(api("/notifications/preferences"), { method: "PUT", as: BOB, body: { email_enabled: true } })).status).toBe(400);
  });

  it("are strictly the caller's own: listing, counting and marking read", async () => {
    const { tid } = await team();
    await comment(tid, ALICE, { mentions: [BOB] });
    const bobs = await json(await call(api("/notifications"), { as: BOB }));
    expect(bobs.unread).toBe(1);
    const nid = bobs.notifications[0].id;
    expect((await json(await call(api("/notifications"), { as: ALICE }))).notifications).toEqual([]);
    expect((await post(`/notifications/${nid}/read`, {}, ALICE)).status).toBe(404);
    await post("/notifications/read-all", {}, ALICE);
    expect((await json(await call(api("/notifications/unread-count"), { as: BOB }))).unread).toBe(1);
    expect((await post(`/notifications/${nid}/read`, {}, BOB)).status).toBe(200);
    expect((await json(await call(api("/notifications/unread-count"), { as: BOB }))).unread).toBe(0);
    expect((await json(await call(api("/notifications?all=1"), { as: BOB }))).notifications[0].read).toBe(true);
  });

  it("the owner is told when someone joins through an invite link", async () => {
    const pid = await createProject(ALICE, "Joinable");
    await call(api("/profile"), { method: "PUT", as: BOB, body: { display_name: "Bob" } });
    const inv = await invite(ALICE, pid, "editor");
    expect((await redeem(BOB, inv.token)).status).toBe(201);
    expect((await notes(ALICE)).map((n) => [n.type, n.title, n.link])).toEqual([["project_shared", 'Bob joined "Joinable" as editor', `/projects/${pid}`]]);
  });

  it("keep at most the newest per person", async () => {
    await createProject(ALICE);
    for (let i = 0; i < MAX_NOTIFICATIONS_PER_PERSON + 5; i += 1) {
      await env.DB.prepare("INSERT INTO notifications (id, subject, type, title, created_at) VALUES (?, ?, 'comment_reply', ?, ?)").bind(crypto.randomUUID(), ALICE, `n${i}`, new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()).run();
    }
    await notify(env.DB, [ALICE], BOB, { type: "comment_reply", title: "newest" });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM notifications WHERE subject = ?").bind(ALICE).first<any>()).n).toBe(MAX_NOTIFICATIONS_PER_PERSON);
  });

  it("deleting a person's data removes their comments and replies in other people's projects", async () => {
    const { tid } = await team();
    const { id } = await comment(tid, BOB);
    await post(`/texts/${tid}/annotations/${id}/replies`, { body: "reply by alice" }, ALICE);
    await comment(tid, ALICE);
    expect((await call(api("/me/data"), { method: "DELETE", as: BOB, body: { confirm: "delete my data" } })).status).toBe(200);
    const left = (await env.DB.prepare("SELECT body FROM annotations WHERE text_id = ?").bind(tid).all<any>()).results.map((r) => r.body);
    expect(left).toEqual(["Look here"]);
  });
});
