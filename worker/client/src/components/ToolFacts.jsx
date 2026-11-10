import { formatBytes } from './ui';

/** What the tool does and the rules that apply, in plain words. Shown on first run and on the Help page. */
export function WhatItDoes() {
  return (
    <ul className="list-disc space-y-1 pl-5">
      <li><strong>Image to Markdown:</strong> upload photos, scans or a PDF of a printed or handwritten text. A model reads each page; you check and correct the text next to the page image, then export it for Manifold.</li>
      <li><strong>PDF to HTML:</strong> upload a PDF, such as a textbook chapter with tables and mathematics. Each page becomes HTML with formulas as TeX; you correct the HTML next to a live preview, then export it for Manifold, where formulas become MathML.</li>
    </ul>
  );
}

export function ToolRules({ session }) {
  const quota = formatBytes(session.storage.quota_bytes);
  const { days, warn_days: warn } = session.retention;
  return (
    <ul className="list-disc space-y-1 pl-5">
      <li><strong>Not for protected data.</strong> Do not upload material covered by FERPA, IRB protocols or HIPAA, or other personally identifiable information. This tool is not approved for it.</li>
      <li><strong>Storage:</strong> {quota} for the projects you own, including pages, PDFs, figures and saved versions. Files a collaborator adds to your project count against yours.</li>
      <li><strong>How long work is kept:</strong> a project is deleted {days} days after its last edit. You are warned {warn} days before, here and in Notifications; any edit keeps it. Export anything you want to keep.</li>
      <li><strong>Model use:</strong> reading pages, converting PDFs, summaries and translations are paid from your own CAIL model allowance, the same one other CAIL tools use. The allowance line under each tool is an estimate that updates with a delay.</li>
      <li><strong>Versions:</strong> each time text is replaced (by a save, an OCR run, a conversion or a restore) the earlier text is kept as a version you can view and restore.</li>
    </ul>
  );
}

export function LegacyDifferences() {
  return (
    <ul className="list-disc space-y-1 pl-5">
      <li>Figures are not extracted from PDFs automatically. Add each figure image by hand with “Add a figure image”, then reference it by file name.</li>
      <li>HTML is edited as source next to a live preview, instead of the earlier rich editor. The preview shows formulas as they will look.</li>
      <li>Sign-in is CUNY Login through the CAIL portal; there are no separate accounts or passwords.</li>
      <li>Notifications are in the app only; there are no emails.</li>
      <li>Models come from the CAIL catalog; each page model can be chosen per run.</li>
    </ul>
  );
}

export { formatBytes };
