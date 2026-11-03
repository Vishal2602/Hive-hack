// Step 2. Admins create a real token through the token_create command and see it once, with config snippets
// built from the service's real /mcp endpoint. Members cannot create tokens (the daemon refuses token_create
// for them), so they get the same snippets with a placeholder for the token they already hold.
import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Alert } from '@/components/arc/alert/alert';
import { Button } from '@/components/arc/button/button';
import { CodeBlock } from '@/components/arc/code-block/code-block';
import { Input } from '@/components/arc/input/input';
import SegmentedControl from '@/components/arc/segmented-control/segmented-control';
import { Select } from '@/components/arc/select/select';
import { ROLE_DESCRIPTION, ROLE_LABEL, type Role } from '@/mock';
import { useHive, useMediaQuery } from '@/shell';
import { CONNECT_CLIENTS, REMOTE_SCOPE_NOTE, TOKEN_PLACEHOLDER, clientById, configSnippet, inviteLink, mcpUrl, type ConnectClientId } from './logic';
import { CopyRow, whereToPaste, type Invite } from './shared';
import styles from './Connect.module.css';

const ROLES: Role[] = ['member', 'admin', 'viewer'];

interface InviteStepProps {
  invite: Invite | null;
  client: ConnectClientId;
  onClientChange: (client: ConnectClientId) => void;
  onCreated: (invite: Invite) => void;
  onStartOver: () => void;
  onBack: () => void;
  onContinue: () => void;
}

export function InviteStep({ invite, client, onClientChange, onCreated, onStartOver, onBack, onContinue }: InviteStepProps) {
  const { me, identity, createToken, connection, workspace, tokens, snapshot, mode } = useHive();
  const isAdmin = me?.role === 'admin';
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [nameError, setNameError] = useState<string | undefined>();
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const clientLabelId = useId();
  const offline = connection === 'offline';
  const narrow = useMediaQuery('(max-width: 519px)');

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (offline || busy) return;
    const person = name.trim();
    if (!person) {
      setNameError('Enter the name of the person you are inviting.');
      return;
    }
    if (person.length > 80) {
      setNameError('Keep the name under 80 characters.');
      return;
    }
    const clientName = clientById(client).name;
    setBusy(true);
    setCreateError(null);
    try {
      // Live: POST /command token_create (admin only). The secret comes back once and is never stored.
      const created = await createToken({ name: person, role, label: `${person} · ${clientName}`.slice(0, 80), client });
      onCreated({ secret: created.secret, tokenId: created.token.id, memberName: created.member.name, role, own: created.member.name === me?.name, baselineSessionIds: [] });
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Hive could not create the token.');
    } finally {
      setBusy(false);
    }
  }

  function chooseOwnToken() {
    // The signed-in member's own token: /me.tokenId live, the member's first active token in prototype data.
    const ownId = identity?.tokenId ?? (mode === 'mock' ? tokens.find(t => t.memberId === me?.id && !t.revokedAt)?.id ?? null : null);
    const baseline = snapshot.sessions.filter(s => ownId !== null && s.tokenId === ownId).map(s => s.id)
      .concat(mode === 'mock' ? tokens.find(t => t.id === ownId)?.agentSessionIds ?? [] : []);
    onCreated({ secret: null, tokenId: ownId, memberName: me?.name ?? 'You', role: me?.role ?? 'member', own: true, baselineSessionIds: baseline });
  }

  const clientOptions = CONNECT_CLIENTS.map(c => ({ value: c.id, label: c.name }));
  const clientPicker = narrow ? (
    <Select
      label="Where the agent runs"
      value={client}
      onValueChange={(value) => onClientChange(value as ConnectClientId)}
      options={clientOptions}
    />
  ) : (
    <div className={[styles.field, styles.fieldStart].join(' ')}>
      <span id={clientLabelId} className={styles.fieldLabel}>Where the agent runs</span>
      <SegmentedControl
        label="Where the agent runs"
        value={client}
        onValueChange={(value) => onClientChange(value as ConnectClientId)}
        options={clientOptions}
      />
    </div>
  );

  if (!invite && !isAdmin) {
    return (
      <div className={styles.panel}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>Connect your own agent</h2>
          <p className={styles.secondary}>{`Your agent signs in with your own token, so its work shows up as ${me?.name ?? 'you'}.`}</p>
        </div>
        <Alert tone="info" title="Only admins can create tokens">
          Hive refuses token creation for member tokens. Use the token you signed in with, or ask an admin for a separate one per machine so it can be revoked on its own.
        </Alert>
        <div className={styles.actions}>
          <Button type="button" variant="ghost" onClick={onBack}>Back</Button>
          <div className={styles.actionsEnd}>
            <Button onClick={chooseOwnToken}>Use my token</Button>
          </div>
        </div>
      </div>
    );
  }

  if (!invite) {
    return (
      <form className={styles.panel} onSubmit={onSubmit} noValidate aria-labelledby="invite-title">
        <div className={styles.sectionHead}>
          <h2 id="invite-title" className={styles.sectionTitle}>Who are you inviting?</h2>
          <p className={styles.secondary}>
            Each person gets their own token, so you can see whose agent did what and revoke one person without touching anyone else.
          </p>
        </div>

        <div className={styles.form}>
          <div className={styles.formRow}>
            <Input
              label="Name"
              placeholder="Priya"
              autoComplete="off"
              maxLength={80}
              value={name}
              onChange={(event) => { setName(event.target.value); if (nameError) setNameError(undefined); }}
              description="Agents they connect show up as this name."
              error={nameError}
            />
            <Select
              label="Role"
              value={role}
              onValueChange={(value) => setRole(value as Role)}
              description={ROLE_DESCRIPTION[role]}
              options={ROLES.map(r => ({ value: r, label: ROLE_LABEL[r] }))}
            />
          </div>
          {clientPicker}
        </div>

        {createError && (
          <Alert tone="danger" title="Hive did not create the token">{createError}</Alert>
        )}

        <div className={styles.actions}>
          <Button type="button" variant="ghost" onClick={onBack}>Back</Button>
          <div className={styles.actionsEnd}>
            <Button type="submit" disabled={offline || busy}>{busy ? 'Creating…' : 'Generate token'}</Button>
          </div>
        </div>
        {offline && <p className={styles.muted} role="status">Hive is unreachable, so new tokens cannot be created right now.</p>}
      </form>
    );
  }

  const option = clientById(client);
  const tokenText = invite.secret ?? TOKEN_PLACEHOLDER;
  const snippet = configSnippet(client, workspace.cloudLink, tokenText);
  const prefix = tokens.find(t => t.id === invite.tokenId)?.prefix ?? invite.secret?.slice(0, 12) ?? '';
  const self = invite.own;

  return (
    <div className={styles.panel}>
      {invite.secret !== null ? (
        <section className={styles.section} aria-labelledby="token-title">
          <div className={styles.sectionHead}>
            <h2 id="token-title" className={styles.sectionTitle}>{`${invite.memberName}'s token`}</h2>
            <p className={styles.secondary}>{`${ROLE_LABEL[invite.role]}. ${ROLE_DESCRIPTION[invite.role]}`}</p>
          </div>
          <CopyRow value={invite.secret} label="Copy token" />
          <Alert tone="warning" title="This is the only time Hive shows this token">
            {`Hive keeps only its first characters (${prefix}) to tell tokens apart. Copy it now and send it privately. If it is lost, revoke it on the Members page and generate a new one.`}
          </Alert>
        </section>
      ) : null}

      <section className={styles.section} aria-labelledby="config-title">
        <div className={styles.sectionHead}>
          <h2 id="config-title" className={styles.sectionTitle}>{self ? 'Connect your client' : 'Connect their client'}</h2>
          <p className={styles.secondary}>
            {invite.secret !== null
              ? 'The endpoint and token are already filled in.'
              : `The endpoint is filled in. Replace ${TOKEN_PLACEHOLDER} with the token you signed in with.`}
          </p>
        </div>
        {clientPicker}
        <div className={styles.snippetMeta}>
          {client === 'mcp' ? (
            <dl className={styles.facts}>
              <div className={styles.fact}>
                <dt>URL</dt>
                <dd><CopyRow value={mcpUrl(workspace.cloudLink)} label="Copy URL" /></dd>
              </div>
              <div className={styles.fact}>
                <dt>Header</dt>
                <dd><CopyRow value={`Authorization: Bearer ${tokenText}`} label="Copy header" /></dd>
              </div>
            </dl>
          ) : (
            <CodeBlock code={snippet} filename={option.snippetLabel} language={option.snippetLanguage} />
          )}
          <p className={styles.muted}>{whereToPaste(client, self ? null : invite.memberName)}</p>
          {option.caveat && <p className={styles.muted}>{option.caveat}</p>}
          <p className={styles.muted}>{REMOTE_SCOPE_NOTE}</p>
        </div>
      </section>

      {invite.secret !== null && (
        <section className={styles.section} aria-labelledby="link-title">
          <div className={styles.sectionHead}>
            <h2 id="link-title" className={styles.sectionTitle}>Or send an invite link</h2>
            <p className={styles.secondary}>
              {`Opening it signs ${invite.memberName} in to this workspace in the browser. The token sits after the #, so it is never sent to a server, but anyone holding the link can use it.`}
            </p>
          </div>
          <CopyRow value={inviteLink(workspace.cloudLink, import.meta.env.BASE_URL, invite.secret)} label="Copy invite link" />
        </section>
      )}

      <div className={styles.actions}>
        <Button variant="ghost" onClick={onStartOver}>{isAdmin ? 'Invite someone else' : 'Back'}</Button>
        <div className={styles.actionsEnd}>
          <Button onClick={onContinue}>{self ? 'Wait for your agent' : 'Wait for their agent'}</Button>
        </div>
      </div>
      {invite.secret !== null && (
        <p className={styles.muted}>
          Starting over hides this token for good. It stays valid until you revoke it on <Link to="/members">Members</Link>.
        </p>
      )}
    </div>
  );
}
