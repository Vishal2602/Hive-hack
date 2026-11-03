// Members and tokens: who can reach this workspace over its cloud link, and the tokens their agents use.
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserPlus } from 'lucide-react';
import { Alert } from '@/components/arc/alert/alert';
import { Button } from '@/components/arc/button/button';
import { EmptyState } from '@/components/arc/empty-state/empty-state';
import { Page, useMock, useNow } from '@/shell';
import { members as seedMembers, tokens as seedTokens } from '@/mock';
import { AccessAside } from './members/AccessAside';
import { MemberSection } from './members/MemberSection';
import { INVITE_PATH, buildRows, canManage } from './members/model';
import styles from './members/members.module.css';

const seedMemberIds = new Set(seedMembers.map(m => m.id));
const seedTokenIds = new Set(seedTokens.map(t => t.id));

export default function Members() {
  const { members, tokens, me, dataset, connection, sessionName } = useMock();
  const navigate = useNavigate();
  const now = useNow(15_000);
  const [previewViewer, setPreviewViewer] = useState(false);

  const myRole = me?.role ?? 'viewer';
  const role = previewViewer ? 'viewer' : myRole;
  const readOnly = role === 'viewer';
  const offline = connection === 'offline';

  // The empty workspace keeps only you (signed in with the bootstrap token) and anyone invited since.
  const empty = dataset === 'empty';
  const visibleMembers = useMemo(
    () => (empty ? members.filter(m => m.id === me?.id || !seedMemberIds.has(m.id)) : members),
    [empty, members, me?.id],
  );
  const visibleTokens = useMemo(() => (empty ? tokens.filter(t => !seedTokenIds.has(t.id)) : tokens), [empty, tokens]);

  const rows = useMemo(() => {
    const list = buildRows(visibleMembers, visibleTokens, sessionName, now);
    // You first, then by role, then by name.
    const rank = { admin: 0, member: 1, viewer: 2 } as const;
    return list.sort((a, b) =>
      Number(b.member.id === me?.id) - Number(a.member.id === me?.id)
      || rank[a.member.role] - rank[b.member.role]
      || a.member.name.localeCompare(b.member.name));
  }, [visibleMembers, visibleTokens, sessionName, now, me?.id]);

  const others = rows.filter(r => r.member.id !== me?.id);
  const activeTokens = visibleTokens.filter(t => !t.revokedAt).length;
  const invite = () => navigate(INVITE_PATH);

  const summary = `${rows.length} ${rows.length === 1 ? 'person' : 'people'} and ${activeTokens} active ${activeTokens === 1 ? 'token' : 'tokens'}. Members join over the cloud link from anywhere.`;

  return (
    <Page
      title="Members"
      description={summary}
      actions={role !== 'admin' ? undefined : (
        <Button variant="primary" onClick={invite} disabled={offline}>
          <UserPlus size={16} strokeWidth={1.75} aria-hidden="true" />
          Invite member
        </Button>
      )}
    >
      {readOnly && (
        <Alert tone="info" title={previewViewer ? 'Previewing the viewer role' : 'You have read-only access'}>
          {previewViewer
            ? 'Invite, rename and revoke are hidden, as they are for viewers. Turn off the preview to manage access again.'
            : 'You can see who has access and which agents they run. Ask an admin to invite people or revoke tokens.'}
        </Alert>
      )}
      {offline && !readOnly && (
        <p className={styles.offlineNote}>You are offline. Inviting, renaming and revoking come back when the connection does.</p>
      )}

      <div className={styles.layout}>
        <div className={styles.list}>
          {rows.map(row => (
            <MemberSection
              key={row.member.id}
              row={row}
              isMe={row.member.id === me?.id}
              manageable={canManage(role, me?.id, row.member.id)}
              offline={offline}
              now={now}
              bootstrap={row.member.id === me?.id && row.member.role === 'admin' && row.tokens.length === 0}
            />
          ))}

          {others.length === 0 && (
            <div className={styles.empty}>
              <EmptyState
                title="No one else has joined yet"
                description={role !== 'admin'
                  ? 'When an admin invites people, they and their agents appear here.'
                  : 'Invite a teammate to generate their token and a ready config for their coding agent. They connect over the cloud link from wherever they work.'}
                action={role !== 'admin' ? undefined : (
                  <Button variant="secondary" onClick={invite} disabled={offline}>Invite member</Button>
                )}
              />
            </div>
          )}
        </div>

        <AccessAside myRole={myRole} previewViewer={previewViewer} onPreviewViewerChange={setPreviewViewer} />
      </div>
    </Page>
  );
}
