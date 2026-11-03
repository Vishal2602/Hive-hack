import { z } from 'zod';
const text = z.string().min(1).max(2000);
const uuid = z.string().uuid();
export const intentSchema = z.object({ task: text,
  files: z.array(text).max(100), symbols: z.array(text).max(100),
  assumptions: z.array(z.object({ key: text, value: text })).max(100) });
export const proposeSchema = z.object({
  title: text,
  declaration: z.string().min(1).max(16000),
  participants: z.array(uuid).min(1).max(10),
  producerSymbol: text.optional(),
  behaviorNotes: z.string().max(4000).optional(),
});
export const operationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('add_field'), symbol: text, name: text, type: text, optional: z.boolean().default(false) }),
  z.object({ kind: z.literal('change_signature'), symbol: text, declaration: z.string().min(1).max(4000) }),
  z.object({ kind: z.literal('rename_symbol'), symbol: text, newName: text }),
  z.object({ kind: z.literal('add_endpoint'), file: text, method: text, route: text, responseType: text }),
]);
export const claimRuleSchema = z.object({ kind: z.literal('field_required'), symbol: text, field: text, type: text.optional(), note: z.string().max(2000).optional() });
export const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('register'), name: text, workspace: text.optional(), client: text.optional() }),
  z.object({ action: z.literal('heartbeat'), sessionId: uuid }),
  z.object({ action: z.literal('finish'), sessionId: uuid }),
  z.object({ action: z.literal('intent'), sessionId: uuid, intent: intentSchema }),
  z.object({ action: z.literal('propose'), sessionId: uuid, ...proposeSchema.shape }),
  z.object({ action: z.literal('acknowledge'), sessionId: uuid, contractId: uuid, version: z.number().int().positive() }),
  z.object({ action: z.literal('revise'), sessionId: uuid, contractId: uuid, title: text.optional(),
    declaration: z.string().min(1).max(16000).optional(), behaviorNotes: z.string().max(4000).optional() }),
  z.object({ action: z.literal('reject'), sessionId: uuid, contractId: uuid, reason: text }),
  z.object({ action: z.literal('reindex'), sessionId: uuid }),
  z.object({ action: z.literal('symbol'), sessionId: uuid, reference: text }),
  z.object({ action: z.literal('preview'), sessionId: uuid, operation: operationSchema }),
  z.object({ action: z.literal('apply'), sessionId: uuid, proposalId: uuid }),
  z.object({ action: z.literal('contract_check'), sessionId: uuid, contractId: uuid }),
  z.object({ action: z.literal('verify'), sessionId: uuid, contractId: uuid, command: text }),
  // Status of a verification run. With sessionId (the MCP tools always send it) the session is heartbeated and must be the caller's.
  z.object({ action: z.literal('verify_status'), runId: uuid, sessionId: uuid.optional() }),
  z.object({ action: z.literal('claim'), sessionId: uuid, rule: claimRuleSchema }),
  z.object({ action: z.literal('analyze'), sessionId: uuid, force: z.boolean().optional() }),
  // Hook actions: authenticated by the shared token only; a hook process has no MCP session of its own.
  z.object({ action: z.literal('sync') }),
  z.object({ action: z.literal('hook_check'), file: text, clientSession: text.optional() }),
  // Members and tokens. token_* are admin-only (src/server/auth.ts); the token value is returned once by token_create.
  z.object({ action: z.literal('member_list') }),
  z.object({ action: z.literal('token_create'), label: z.string().trim().min(1).max(80), member: z.string().trim().min(1).max(80),
    role: z.enum(['admin', 'member', 'viewer']) }),
  z.object({ action: z.literal('token_list') }),
  z.object({ action: z.literal('token_rename'), tokenId: uuid, label: z.string().trim().min(1).max(80) }),
  z.object({ action: z.literal('token_revoke'), tokenId: uuid }),
]);
export type Command = z.infer<typeof commandSchema>;
