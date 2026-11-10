import { Link } from 'react-router-dom';
import { useSession } from '../api/session.jsx';
import { LegacyDifferences, ToolRules, WhatItDoes } from '../components/ToolFacts';

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
        <p className="mt-1">Everything works from the keyboard: Tab moves between controls, Enter or Space activates them. Use the arrow buttons next to a page or a text to move it up or down; the export follows that order.</p>
      </section>
      <p><Link to="/">Back to your projects</Link></p>
    </article>
  );
}
