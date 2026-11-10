import { Link } from 'react-router-dom';
import { useSession } from '../api/session.jsx';
import { LegacyDifferences, ToolRules, WhatItDoes } from '../components/ToolFacts';
import { ShortcutList } from '../hooks/useShortcuts';

export default function HelpPage() {
  const { session } = useSession();
  return (
    <article className="max-w-prose space-y-6 text-sm leading-relaxed">
      <h1 className="text-2xl">Help</h1>
      <section aria-labelledby="help-what">
        <h2 id="help-what" className="text-lg">What this tool does</h2>
        <p className="mt-1">Manifold Companion turns source material into text you can publish on Manifold. Start a project and pick one of two workflows:</p>
        <div className="mt-2"><WhatItDoes /></div>
      </section>
      <section aria-labelledby="help-rules">
        <h2 id="help-rules" className="text-lg">Rules and limits</h2>
        <div className="mt-2"><ToolRules session={session} /></div>
      </section>
      <section aria-labelledby="help-upload">
        <h2 id="help-upload" className="text-lg">Uploading</h2>
        <p className="mt-1">Use the upload buttons, or drop files anywhere on a text's page. An image text takes photos, scans (JPEG, PNG, WebP) and PDFs; each PDF page becomes a page image in your browser. A PDF text takes one PDF to convert (dropping it only chooses it; nothing is sent until you press Convert) and images, which become figures. Other files are named and left out. HEIC photos work only in a browser that opens them, such as Safari; elsewhere convert them to JPEG first. An upload that stops arriving is cancelled after a few minutes and its storage is given back; try again on a steadier connection.</p>
      </section>
      <section aria-labelledby="help-fulltext">
        <h2 id="help-fulltext" className="text-lg">Full text of an image text</h2>
        <p className="mt-1">The export joins the text of each page. Under “Full text” you can instead edit the whole text at once, for example to join a paragraph that runs across two pages. Once you save it, the export uses that full text, and later edits to single pages no longer reach the export. “Use the pages again” switches back; the full text is kept in its version history.</p>
      </section>
      <section aria-labelledby="help-move">
        <h2 id="help-move" className="text-lg">Moving texts to another project</h2>
        <p className="mt-1">Select texts in a project and choose “Move to project”. You can move them into any project of the same kind where you are an editor or the owner. Their pages, files, version history, metadata and model settings go with them; their comments are deleted, because they were written for the members of the project they were in. Moved texts get new addresses, so old links to them stop working. If the other project has a different owner, the texts' storage counts against that owner from then on. The confirmation says all of this, with the numbers, before anything moves.</p>
      </section>
      <section aria-labelledby="help-unsaved">
        <h2 id="help-unsaved" className="text-lg">Unsaved changes</h2>
        <p className="mt-1">If you try to leave a text, close the tab or open another page of the text while an edit is not saved, the app asks first. This browser also keeps a copy of the unsaved edit, for that text only, and offers it the next time you open the text here: restore it, then save, or discard it. The copy is removed when you save or discard, after 7 days, when someone else signs in on this browser, and from Settings. It never leaves this browser, and nobody else sees it; only Save makes an edit part of the project.</p>
      </section>
      <section aria-labelledby="help-checks">
        <h2 id="help-checks" className="text-lg">Checking model output</h2>
        <p className="mt-1">Models make mistakes, especially with graphs, handwriting and dense tables. Compare every page with its image before you export. After a PDF conversion the editor lists pages to check by eye, for example a figure description that gives values read off a graph, or a numbered list that restarts at 1.</p>
      </section>
      <section aria-labelledby="help-legacy">
        <h2 id="help-legacy" className="text-lg">What is different from the earlier version</h2>
        <p className="mt-1">If you used Manifold Companion on the lab's earlier server:</p>
        <div className="mt-2"><LegacyDifferences /></div>
      </section>
      <section aria-labelledby="help-keys">
        <h2 id="help-keys" className="text-lg">Keyboard</h2>
        <p className="mt-1">Everything works from the keyboard: Tab moves between controls, Enter or Space activates them. Use the arrow buttons next to a page or a text to move it up or down; the export follows that order. These shortcuts save steps (single-key ones work only outside text fields, and can be turned off in Settings):</p>
        <div className="mt-2"><ShortcutList /></div>
      </section>
      <p><Link to="/">Back to your projects</Link></p>
    </article>
  );
}
