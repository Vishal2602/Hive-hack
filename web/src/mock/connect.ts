// Client options and ready-to-paste configuration for joining a workspace over its cloud link.
import type { ClientId } from './types.ts';

export interface ClientOption {
  id: ClientId;
  name: string;
  description: string;
  /** Short label for the snippet block, e.g. "Terminal" or "mcp.json". */
  snippetLabel: string;
  snippetLanguage: 'bash' | 'json';
}

export const CLIENTS: ClientOption[] = [
  { id: 'claude-code', name: 'Claude Code', description: 'Adds Hive as a remote MCP server with one command.', snippetLabel: 'Terminal', snippetLanguage: 'bash' },
  { id: 'muse-code', name: 'Muse Code', description: 'Paste into the MCP servers section of Muse Code settings.', snippetLabel: 'settings.json', snippetLanguage: 'json' },
  { id: 'mcp', name: 'Other MCP client', description: 'Any client that supports streamable HTTP servers with headers.', snippetLabel: 'mcp.json', snippetLanguage: 'json' },
];

export const mcpEndpoint = (cloudLink: string) => `${cloudLink.replace(/\/$/, '')}/mcp`;

/** The exact text a person pastes to connect a client. Token and link are filled in. */
export function configSnippet(client: ClientId, cloudLink: string, token: string): string {
  const url = mcpEndpoint(cloudLink);
  if (client === 'claude-code') {
    return `claude mcp add --transport http hive ${url} \\\n  --header "Authorization: Bearer ${token}"`;
  }
  const server = { type: 'http', url, headers: { Authorization: `Bearer ${token}` } };
  const body = client === 'muse-code' ? { 'muse.mcpServers': { hive: server } } : { mcpServers: { hive: server } };
  return JSON.stringify(body, null, 2);
}

/** Invite link. The token rides in the fragment, which browsers never send to the server. */
export const inviteLink = (appOrigin: string, token: string) => `${appOrigin.replace(/\/$/, '')}/join#token=${encodeURIComponent(token)}`;
