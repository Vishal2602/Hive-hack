// Pure logic for the sign-in and Connect screens: client config snippets built from the real endpoints,
// invite links, token paste clean-up and the "waiting for the first agent" progress.
// No imports at all, so the backend test suite runs this file directly under Node (strip-only).

export type ConnectClientId = 'claude-code' | 'muse-code' | 'mcp';

export interface ConnectClient {
  id: ConnectClientId;
  name: string;
  /** Label above the snippet, e.g. "Terminal". */
  snippetLabel: string;
  snippetLanguage: 'bash' | 'json' | 'text';
  /** Shown under the snippet when the format is not confirmed against the client itself. */
  caveat: string | null;
}

export const CONNECT_CLIENTS: readonly ConnectClient[] = [
  { id: 'claude-code', name: 'Claude Code', snippetLabel: 'Terminal', snippetLanguage: 'bash', caveat: null },
  { id: 'muse-code', name: 'Muse Code', snippetLabel: 'MCP servers', snippetLanguage: 'json',
    caveat: 'Format taken from the Meta docs. Verify it on your install.' },
  { id: 'mcp', name: 'Other MCP client', snippetLabel: 'URL and header', snippetLanguage: 'text', caveat: null },
];

export const clientById = (id: ConnectClientId): ConnectClient => CONNECT_CLIENTS.find(c => c.id === id) ?? CONNECT_CLIENTS[0]!;

/** One sentence the Connect flow shows next to the config, as the design spec requires. */
export const REMOTE_SCOPE_NOTE = 'Remote agents coordinate intents and agreements through Hive, while code checks run against the service checkout, not the files on your machine.';

/** Placeholder used when the person already holds their token (members cannot create new ones). */
export const TOKEN_PLACEHOLDER = '<your Hive token>';

/** Base of the service: no trailing slash. */
export function serviceBase(cloudLink: string): string {
  return cloudLink.trim().replace(/\/+$/, '');
}

/** The Streamable HTTP MCP endpoint the daemon serves (POST/GET/DELETE /mcp). */
export function mcpUrl(cloudLink: string): string {
  return `${serviceBase(cloudLink)}/mcp`;
}

/** POSIX single-quote quoting: safe for any string, including quotes and spaces. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The exact text a person pastes to connect a client. URL and token are filled in. */
export function configSnippet(client: ConnectClientId, cloudLink: string, token: string): string {
  const url = mcpUrl(cloudLink);
  const header = `Authorization: Bearer ${token}`;
  if (client === 'claude-code') {
    return `claude mcp add --transport http hive ${shellQuote(url)} --header ${shellQuote(header)}`;
  }
  if (client === 'muse-code') {
    const block = { mcp_servers: { hive: { transport: 'streamable_http', url, headers: { Authorization: `Bearer ${token}` } } } };
    return JSON.stringify(block, null, 2);
  }
  return `URL: ${url}\n${header}`;
}

/**
 * Browser invite link. The token rides after the #, which browsers never send to a server.
 * `basePath` is where the app is served (Vite BASE_URL, "/ui/").
 */
export function inviteLink(cloudLink: string, basePath: string, token: string): string {
  const base = `/${basePath.replace(/^\/+|\/+$/g, '')}`.replace(/^\/$/, '');
  return `${serviceBase(cloudLink)}${base}/join#token=${encodeURIComponent(token)}`;
}

/**
 * Cleans what people actually paste into the sign-in field: surrounding whitespace and quotes,
 * an "Authorization:" header name and a "Bearer" prefix. The token itself is never altered.
 */
export function normalizePastedToken(input: string): string {
  let value = input.trim();
  value = value.replace(/^authorization\s*:\s*/i, '');
  value = value.replace(/^bearer\s+/i, '');
  value = value.replace(/^["'`]+|["'`]+$/g, '');
  return value.trim();
}

export interface SessionLike { id: string; tokenId?: string | null; status?: string }
export interface TokenRecordLike { id: string; lastUsedAt: number | null; revokedAt: number | null }

export interface InviteProgressInput {
  /** Token being followed: a token created in step 2, or the signed-in member's own token. */
  tokenId: string | null;
  /** Session ids already registered with this token when waiting started; they do not count. */
  baselineSessionIds: readonly string[];
  sessions: readonly SessionLike[];
  /** Admin only: the token's metadata (never its value). Null when the caller cannot list tokens. */
  record: TokenRecordLike | null;
  /** True when the token was created in this flow (then any use of it is the new client). */
  newToken: boolean;
  /** Extra session ids attributed to the token by other means (prototype data). */
  extraSessionIds?: readonly string[];
}

export interface InviteProgress {
  /** New sessions registered with the token, oldest first as the snapshot lists them. */
  sessionIds: string[];
  /** The token has been presented by some client (new tokens only; own tokens are used by this page). */
  clientSeenAt: number | null;
  registered: boolean;
  revoked: boolean;
}

export function inviteProgress(input: InviteProgressInput): InviteProgress {
  const baseline = new Set(input.baselineSessionIds);
  const ids: string[] = [];
  if (input.tokenId !== null) {
    for (const session of input.sessions) {
      if (session.tokenId === input.tokenId && !baseline.has(session.id) && !ids.includes(session.id)) ids.push(session.id);
    }
  }
  for (const id of input.extraSessionIds ?? []) if (!baseline.has(id) && !ids.includes(id)) ids.push(id);
  const clientSeenAt = input.newToken && input.record ? input.record.lastUsedAt : null;
  return { sessionIds: ids, clientSeenAt, registered: ids.length > 0, revoked: Boolean(input.record?.revokedAt) };
}
