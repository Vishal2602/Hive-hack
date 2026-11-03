// /signin: paste an access token once. The token is kept in sessionStorage by the store, never in localStorage.
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { CircleAlert } from 'lucide-react';
import { Button } from '@/components/arc/button/button';
import { PasswordField } from '@/components/arc/password-field/password-field';
import { DEMO_TOKEN } from '@/mock';
import { Standalone, useMock } from '@/shell';
import styles from './signin/SignIn.module.css';

const showDemoControls = () => import.meta.env.DEV || new URLSearchParams(window.location.search).has('demo');

export default function SignIn() {
  const { me, signIn, workspace } = useMock();
  const navigate = useNavigate();
  const location = useLocation();
  const errorId = useId();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { document.title = 'Sign in · Hive'; }, []);

  const from = (location.state as { from?: string } | null)?.from;
  const destination = from && from !== '/signin' && from !== '/join' ? from : '/';

  if (me) return <Navigate to={destination} replace />;

  function attempt(value: string) {
    if (!value.trim()) {
      setError('Paste your access token to continue.');
      return;
    }
    const result = signIn(value);
    if (result.ok) navigate(destination, { replace: true });
    else setError(result.reason);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    attempt(token);
  }

  return (
    <Standalone>
      <div className={styles.wrap}>
        <section className={styles.card} aria-labelledby="signin-title">
          <span className={styles.wordmark}>Hive</span>
          <div className={styles.heading}>
            <h1 id="signin-title" className={styles.title}>Sign in</h1>
            <p className={styles.lede}>{`Paste the access token an admin gave you for ${workspace.name}. It decides what you can see and which agents you can connect.`}</p>
          </div>

          <form className={styles.form} onSubmit={onSubmit} noValidate>
            <PasswordField
              label="Access token"
              name="token"
              autoComplete="off"
              spellCheck={false}
              placeholder="hive_mem_..."
              value={token}
              onChange={(event) => { setToken(event.target.value); if (error) setError(null); }}
              description="Your token stays in this browser tab and is cleared when you close it."
              messages={{ showPassword: 'Show token', hidePassword: 'Hide token' }}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
            />
            {error && (
              <p id={errorId} className={styles.error} role="alert">
                <CircleAlert size={16} aria-hidden="true" />
                <span>{error}</span>
              </p>
            )}
            <Button type="submit" size="lg" className={styles.submit}>Continue</Button>
          </form>

          <div className={styles.invite}>
            <h2 className={styles.inviteTitle}>Have an invite link?</h2>
            <p>Open it in this browser and you are signed in straight away. The token rides after the # in the link, so it never reaches a server log.</p>
          </div>
        </section>

        {showDemoControls() && (
          <div className={styles.demo}>
            <span>Prototype only</span>
            <Button variant="ghost" size="sm" onClick={() => { setToken(DEMO_TOKEN); attempt(DEMO_TOKEN); }}>
              Sign in as Sanika with the demo token
            </Button>
          </div>
        )}
      </div>
    </Standalone>
  );
}
