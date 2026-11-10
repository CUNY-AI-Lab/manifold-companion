import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { ErrorNote, Spinner } from '../components/ui';

/** /invite#t=<token>. The token lives in the fragment, so it never reaches a server log; it is cleared at once. */
export default function InvitePage() {
  const navigate = useNavigate();
  const [error, setError] = useState(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = new URLSearchParams(window.location.hash.slice(1)).get('t');
    window.history.replaceState(null, '', window.location.pathname);
    if (!token) { setError({ message: 'This invite link is incomplete. Ask the project owner for a new one.' }); return; }
    api.post('/api/invites/redeem', { token }).then((r) => navigate(`/projects/${r.project_id}`, { replace: true }), (e) => {
      if (e.code === 'already_member') setError({ message: 'You already have access to this project. Find it on your projects page.' });
      else setError(e);
    });
  }, [navigate]);
  return <div className="mx-auto max-w-xl">{error ? <><h1 className="text-xl">Invite link not used</h1><ErrorNote error={error} /><a href="./">Go to your projects</a></> : <Spinner label="Joining the project" />}</div>;
}
