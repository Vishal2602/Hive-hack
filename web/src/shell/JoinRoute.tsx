// /join#token=... Invite links carry the token in the fragment, which is never sent to the server.
// The token is moved to sessionStorage, the fragment is removed from history, and the person lands signed in.
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Page } from './Page';
import { useMock } from './store';
import { Standalone } from './Standalone';

export function JoinRoute() {
  const { signIn } = useMock();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  // Read the fragment once; StrictMode may run the effect twice, so the token is captured in state.
  const [token] = useState(() => new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token'));

  useEffect(() => {
    window.history.replaceState(null, '', '/join');
    if (!token) {
      setError('This invite link has no token in it. Ask the person who invited you to send it again.');
      return;
    }
    const result = signIn(token);
    if (result.ok) navigate('/', { replace: true });
    else setError(result.reason);
  }, [token, signIn, navigate]);

  return (
    <Standalone>
      <Page title={error ? 'This invite did not work' : 'Joining workspace'} width="narrow" notices={false}
        description={error ?? 'Checking your invite.'}>
        {error && <p><Link to="/signin">Sign in with a token instead</Link></p>}
      </Page>
    </Standalone>
  );
}
