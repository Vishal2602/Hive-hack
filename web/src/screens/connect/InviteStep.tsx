// Step 2: create a personal token for a teammate, then hand them a ready-to-paste client config or an invite link.
import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Alert } from '@/components/arc/alert/alert';
import { Button } from '@/components/arc/button/button';
import { CodeBlock } from '@/components/arc/code-block/code-block';
import { Input } from '@/components/arc/input/input';
import SegmentedControl from '@/components/arc/segmented-control/segmented-control';
import { Select } from '@/components/arc/select/select';
import { CLIENTS, ROLE_DESCRIPTION, ROLE_LABEL, configSnippet, inviteLink, type ClientId, type Role } from '@/mock';
import { useMediaQuery, useMock } from '@/shell';
import { CopyRow, whereToPaste, type Invite } from './shared';
import styles from './Connect.module.css';

const ROLES: Role[] = ['member', 'admin', 'viewer'];

interface InviteStepProps {
  invite: Invite | null;
  client: ClientId;
  onClientChange: (client: ClientId) => void;
  onCreated: (invite: Invite) => void;
  onStartOver: () => void;
  onBack: () => void;
  onContinue: () => void;
}

export function InviteStep({ invite, client, onClientChange, onCreated, onStartOver, onBack, onContinue }: InviteStepProps) {
  const { me, createToken, connection, workspace, tokens } = useMock();
  const isAdmin = me?.role === 'admin';
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [nameError, setNameError] = useState<string | undefined>();
  const clientLabelId = useId();
  const offline = connection === 'offline';
  const narrow = useMediaQuery('(max-width: 519px)');

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (offline) return;
    const person = isAdmin ? name.trim() : me?.name ?? '';
    if (!person) {
      setNameError('Enter the name of the person you are inviting.');
      return;
    }
    const chosenRole: Role = isAdmin ? role : 'member';
    const clientName = CLIENTS.find(c => c.id === client)?.name ?? 'MCP client';
    const created = createToken({ name: person, role: chosenRole, label: `${person} · ${clientName}`, client });
    onCreated({ secret: created.secret, tokenId: created.token.id, memberName: created.member.name, role: chosenRole });
  }

  const clientOptions = CLIENTS.map(c => ({ value: c.id, label: c.name }));
  const clientPicker = narrow ? (
    <Select
      label="Where the agent runs"
      value={client}
      onValueChange={(value) => onClientChange(value as ClientId)}
      options={clientOptions}
    />
  ) : (
    <div className={[styles.field, styles.fieldStart].join(' ')}>
      <span id={clientLabelId} className={styles.fieldLabel}>Where the agent runs</span>
      <SegmentedControl
        label="Where the agent runs"
        value={client}
        onValueChange={(value) => onClientChange(value as ClientId)}
        options={clientOptions}
      />
    </div>
  );

  if (!invite) {
    return (
      <form className={styles.panel} onSubmit={onSubmit} noValidate aria-labelledby="invite-title">
        <div className={styles.sectionHead}>
          <h2 id="invite-title" className={styles.sectionTitle}>{isAdmin ? 'Who are you inviting?' : 'Connect your own agent'}</h2>
          <p className={styles.secondary}>
            {isAdmin
              ? 'Each person gets their own token, so you can see whose agent did what and revoke one person without touching anyone else.'
              : `Only admins can invite other people. You can create a token for your own agent, signed as ${me?.name ?? 'you'}.`}
          </p>
        </div>

        <div className={styles.form}>
          {isAdmin ? (
            <div className={styles.formRow}>
              <Input
                label="Name"
                placeholder="Priya"
                autoComplete="off"
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
          ) : (
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Token for</span>
              <span className={styles.fixedValue}>{me?.name ?? 'You'}, as a member</span>
            </div>
          )}
          {clientPicker}
        </div>

        <div className={styles.actions}>
          <Button type="button" variant="ghost" onClick={onBack}>Back</Button>
          <div className={styles.actionsEnd}>
            <Button type="submit" disabled={offline}>Generate token</Button>
          </div>
        </div>
        {offline && <p className={styles.muted} role="status">Hive is unreachable, so new tokens cannot be created right now.</p>}
      </form>
    );
  }

  const option = CLIENTS.find(c => c.id === client) ?? CLIENTS[0];
  const snippet = configSnippet(client, workspace.cloudLink, invite.secret);
  const link = inviteLink(workspace.cloudLink, invite.secret);
  const prefix = tokens.find(t => t.id === invite.tokenId)?.prefix ?? invite.secret.slice(0, 12);
  const isSelf = invite.memberName === me?.name;

  return (
    <div className={styles.panel}>
      <section className={styles.section} aria-labelledby="token-title">
        <div className={styles.sectionHead}>
          <h2 id="token-title" className={styles.sectionTitle}>{isSelf ? 'Your token' : `${invite.memberName}'s token`}</h2>
          <p className={styles.secondary}>{ROLE_LABEL[invite.role]}. {ROLE_DESCRIPTION[invite.role]}</p>
        </div>
        <CopyRow value={invite.secret} label="Copy token" />
        <Alert tone="warning" title="This is the only time Hive shows this token">
          {`Hive keeps only its first characters (${prefix}) to tell tokens apart. Copy it now and send it privately. If it is lost, revoke it on the Members page and generate a new one.`}
        </Alert>
      </section>

      <section className={styles.section} aria-labelledby="config-title">
        <div className={styles.sectionHead}>
          <h2 id="config-title" className={styles.sectionTitle}>{isSelf ? 'Connect your client' : 'Connect their client'}</h2>
          <p className={styles.secondary}>The cloud link and token are already filled in.</p>
        </div>
        {clientPicker}
        <div className={styles.snippetMeta}>
          <CodeBlock code={snippet} filename={option.snippetLabel} language={option.snippetLanguage} />
          <p className={styles.muted}>{whereToPaste(client, isSelf ? null : invite.memberName)}</p>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="link-title">
        <div className={styles.sectionHead}>
          <h2 id="link-title" className={styles.sectionTitle}>Or send an invite link</h2>
          <p className={styles.secondary}>
            {`Opening it signs ${isSelf ? 'you' : invite.memberName} in to this workspace in the browser. The token sits after the #, so it is never sent to a server, but anyone holding the link can use it.`}
          </p>
        </div>
        <CopyRow value={link} label="Copy invite link" />
      </section>

      <div className={styles.actions}>
        <Button variant="ghost" onClick={onStartOver}>{isAdmin ? 'Invite someone else' : 'Create another token'}</Button>
        <div className={styles.actionsEnd}>
          <Button onClick={onContinue}>{isSelf ? 'Wait for your agent' : 'Wait for their agent'}</Button>
        </div>
      </div>
      <p className={styles.muted}>
        Starting over hides this token for good. It stays valid until you revoke it on <Link to="/members">Members</Link>.
      </p>
    </div>
  );
}
