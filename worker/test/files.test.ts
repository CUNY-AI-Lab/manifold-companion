import { describe, expect, it } from "vitest";
import { serveBody } from "../src/files";
import { exportKey, figureKey, htmlKey, pageImageKey, projectPrefix, textPrefix, versionKey } from "../src/r2-keys";

describe("serving stored files", () => {
  it("sets an explicit content type, nosniff and a sandbox CSP, ignoring anything the object claims", async () => {
    const res = serveBody("<script>alert(1)</script>", "html", "evil.html");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toMatch(/^sandbox;/);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
  it("images and PDFs are inline with their own types", () => {
    expect(serveBody(null, "image-png", "a.png").headers.get("content-type")).toBe("image/png");
    expect(serveBody(null, "pdf", "a.pdf").headers.get("content-type")).toBe("application/pdf");
    expect(serveBody(null, "zip", "a.zip").headers.get("content-disposition")).toMatch(/^attachment/);
  });
  it("sanitizes the download file name", () => {
    expect(serveBody(null, "text", 'a"\r\nSet-Cookie: x=1/../b').headers.get("content-disposition")).toBe('inline; filename="a___Set-Cookie__x_1_.._b"');
  });
});

describe("R2 key layout", () => {
  it("keeps every object of a project under one prefix", () => {
    const p = "11111111-1111-4111-8111-111111111111", t = "22222222-2222-4222-8222-222222222222", x = "33333333-3333-4333-8333-333333333333";
    for (const key of [pageImageKey(p, t, x), htmlKey(p, t), versionKey(p, t, x), figureKey(p, t, x), exportKey(p, x)]) expect(key.startsWith(projectPrefix(p))).toBe(true);
    for (const key of [pageImageKey(p, t, x), htmlKey(p, t), versionKey(p, t, x)]) expect(key.startsWith(textPrefix(p, t))).toBe(true);
    expect(projectPrefix(p)).toBe(`p/${p}/`);
  });
});
