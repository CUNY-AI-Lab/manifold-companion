// R2 key layout. Every object of a project lives under `p/{projectId}/` so a
// project (and, by extension, a person's data) is deleted with one prefix sweep.
// Keys are built ONLY from server-generated UUIDs, never from user-supplied
// file names, so a key can neither collide nor traverse. See docs/DESIGN.md.
//
//   p/{project}/t/{text}/page/{page}        page image (browser-resized JPEG/PNG)
//   p/{project}/t/{text}/source.pdf         original PDF (pdf_to_html projects)
//   p/{project}/t/{text}/html               current html_content
//   p/{project}/t/{text}/translation        current translation
//   p/{project}/t/{text}/v/{version}        version snapshot bodies
//   p/{project}/t/{text}/fig/{figure}       extracted figure images
//   p/{project}/export/{export}             generated ZIP (short-lived)

export const projectPrefix = (projectId: string): string => `p/${projectId}/`;
export const textPrefix = (projectId: string, textId: string): string => `p/${projectId}/t/${textId}/`;
export const pageImageKey = (p: string, t: string, page: string): string => `p/${p}/t/${t}/page/${page}`;
export const sourcePdfKey = (p: string, t: string): string => `p/${p}/t/${t}/source.pdf`;
export const htmlKey = (p: string, t: string): string => `p/${p}/t/${t}/html`;
export const translationKey = (p: string, t: string): string => `p/${p}/t/${t}/translation`;
export const versionKey = (p: string, t: string, v: string): string => `p/${p}/t/${t}/v/${v}`;
export const figureKey = (p: string, t: string, f: string): string => `p/${p}/t/${t}/fig/${f}`;
export const exportKey = (p: string, e: string): string => `p/${p}/export/${e}`;

// Revisioned content. Every write of html / compiled / translation goes to a NEW
// key; the previous object then simply becomes the version snapshot (no copy).
//   p/{project}/t/{text}/c/{kind}/{revision}
export type ContentKind = "html" | "compiled" | "translation";
export const contentKey = (p: string, t: string, kind: ContentKind, revision: string): string => `p/${p}/t/${t}/c/${kind}/${revision}`;
// A version snapshot of one page's OCR text (page text itself lives in D1).
export const pageVersionKey = (p: string, t: string, v: string): string => `p/${p}/t/${t}/v/${v}`;
