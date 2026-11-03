// Billing scenario, shaped exactly like the daemon's ServiceSnapshot.
// Three agents work on hive-playground; two of them disagree about the unit getPrice returns.
import { minutesAgo, minutesFromNow } from './time.ts';
import type {
  Analysis, Contract, Finding, HiveEvent, Intent, Proposal, ServiceSnapshot, Session, VerificationRun,
} from './types.ts';

export const REPOSITORY_ID = '0b6f4a52-1d3e-4c7a-9f80-2e5d6c7b8a91';
export const WORKSPACE_ID = '5e8d1c2b-7a4f-4e3d-8b6a-9c0d1e2f3a44';

/** Session ids of the three scenario agents. */
export const SESSION = {
  pricing: '3f6c2a1e-8b4d-4c1a-9e2f-5a7b8c9d0e11',
  invoice: '9a1d4e7b-2c3f-4b8a-8d6e-1f2a3b4c5d22',
  ui: 'c7e2b9f4-5a6d-4e1b-b3c8-7d9e0f1a2b33',
} as const;

export const CONTRACT = {
  getPriceUnit: 'a2c4e6f8-1b3d-4f5a-8c7e-9d0b1a2c3e55',
  receiptLine: 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a66',
} as const;

const HASH = {
  pricing: '8f2a61c94d0e7b3a5c1f9e2d4b6a8c0e1f3d5b7a9c2e4f6a8b0d1c3e5f7a9b2c',
  invoice: '3c7e9a1b5d2f4e6a8c0b1d3f5a7e9c2b4d6f8a0c1e3b5d7f9a2c4e6b8d0f1a3e',
  pricingRev3: '1d4f7a2c5e8b0d3f6a9c2e5b8d1f4a7c0e3b6d9f2a5c8e1b4d7f0a3c6e9b2d5f',
  invoiceRev3: '6b9d2f5a8c1e4b7d0f3a6c9e2b5d8f1a4c7e0b3d6f9a2c5e8b1d4f7a0c3e6b9d',
} as const;

const sessions: Session[] = [
  { id: SESSION.pricing, name: 'Sanika · pricing agent', workspaceId: WORKSPACE_ID, client: 'claude-code', expiresAt: minutesFromNow(4.5), status: 'active' },
  { id: SESSION.invoice, name: 'Vishal · invoice agent', workspaceId: WORKSPACE_ID, client: 'muse-code', expiresAt: minutesFromNow(8), status: 'active' },
  { id: SESSION.ui, name: 'Vishal · UI agent', workspaceId: WORKSPACE_ID, client: 'claude-code', expiresAt: minutesFromNow(2), status: 'active' },
];

const intents: Intent[] = [
  {
    sessionId: SESSION.pricing,
    revision: 2,
    at: minutesAgo(9),
    task: 'Return integer cents from getPrice',
    files: ['src/pricing.ts', 'src/invoice.ts'],
    symbols: ['src/pricing.ts#getPrice:function'],
    assumptions: [{ key: 'src/pricing.ts#getPrice:unit', value: 'cents' }],
  },
  {
    sessionId: SESSION.invoice,
    revision: 1,
    at: minutesAgo(34),
    task: 'Build plain-text receipts',
    files: ['src/invoice.ts', 'src/receipt.ts'],
    symbols: ['src/invoice.ts#lineTotal:function', 'src/receipt.ts#formatReceipt:function'],
    assumptions: [{ key: 'src/pricing.ts#getPrice:unit', value: 'dollars' }],
  },
  {
    sessionId: SESSION.ui,
    revision: 1,
    at: minutesAgo(29),
    task: 'Rename the export button',
    files: ['src/ui/ExportButton.tsx'],
    symbols: ['src/ui/ExportButton.tsx#ExportButton:function'],
    assumptions: [],
  },
];

const GET_PRICE_DECLARATION = "export declare function getPrice(sku: string, unit: 'cents' | 'dollars'): number;";
const GET_PRICE_NOTES = [
  'Callers must pass the unit they expect. There is no default.',
  "'cents' returns an integer number of cents, for example 1999.",
  "'dollars' returns a decimal amount, for example 19.99.",
  'Unknown SKUs throw a RangeError; the function never returns NaN.',
].join('\n');

/** Every verification run, oldest first. The backend keeps the latest on contract.evidence.verification. */
export const verificationRuns: VerificationRun[] = [
  {
    id: 'run-5c1d9e2a',
    contractId: CONTRACT.getPriceUnit,
    version: 1,
    command: 'npm test',
    status: 'failed',
    exitCode: 1,
    passed: false,
    overlay: false,
    revision: 3,
    sourceHashes: { 'src/pricing.ts': HASH.pricingRev3, 'src/invoice.ts': HASH.invoiceRev3 },
    output: [
      '> hive-playground@0.3.0 test',
      '> node --test tests/',
      '',
      'not ok 3 - invoice line total uses the unit price',
      '  ---',
      '  error: |-',
      "    Expected values to be strictly equal:",
      '',
      '    19.99 !== 1999',
      '',
      '  location: tests/invoice.test.ts:18:10',
      '  ...',
      '# tests 6',
      '# pass 5',
      '# fail 1',
    ].join('\n'),
    reasons: ['npm test exited 1: 19.99 !== 1999'],
    at: minutesAgo(14),
    finishedAt: minutesAgo(13.8),
  },
  {
    id: 'run-8e4b7f13',
    contractId: CONTRACT.getPriceUnit,
    version: 1,
    command: 'npm test',
    status: 'passed',
    exitCode: 0,
    passed: true,
    overlay: true,
    revision: 4,
    sourceHashes: { 'src/pricing.ts': HASH.pricing, 'src/invoice.ts': HASH.invoice },
    output: [
      '> hive-playground@0.3.0 test',
      '> node --test tests/',
      '',
      'ok 1 - getPrice returns integer cents',
      'ok 2 - getPrice returns dollars when asked',
      'ok 3 - invoice line total uses the unit price',
      'ok 4 - unknown sku throws RangeError',
      'ok 5 - receipt lists every line',
      'ok 6 - receipt total matches invoice total',
      '# tests 6',
      '# pass 6',
      '# fail 0',
      '',
      'Ran against a staged overlay of revision 4. The change is not applied yet.',
    ].join('\n'),
    reasons: [],
    at: minutesAgo(3),
    finishedAt: minutesAgo(2.8),
  },
];

const contracts: Contract[] = [
  {
    id: CONTRACT.getPriceUnit,
    version: 1,
    title: 'Explicit unit parameter on getPrice',
    ownerSessionId: SESSION.pricing,
    producerSymbol: 'src/pricing.ts#getPrice:function',
    declaration: GET_PRICE_DECLARATION,
    behaviorNotes: GET_PRICE_NOTES,
    participants: [SESSION.pricing, SESSION.invoice],
    acknowledgements: [SESSION.pricing, SESSION.invoice],
    acknowledgementDetails: [
      { sessionId: SESSION.pricing, version: 1, intentRevision: 1, at: minutesAgo(26) },
      { sessionId: SESSION.invoice, version: 1, intentRevision: 1, at: minutesAgo(24) },
    ],
    intentRevisions: { [SESSION.pricing]: 1, [SESSION.invoice]: 1 },
    status: 'implemented',
    evidence: {
      implemented: {
        symbol: 'src/pricing.ts#getPrice:function',
        file: 'src/pricing.ts',
        declarationHash: 'd41c7a9e3b5f2c8a',
        declaration: "function getPrice(sku: string, unit: 'cents' | 'dollars'): number",
        revision: 3,
        at: minutesAgo(18),
      },
      // Latest run on applied code. The passing run in verificationRuns used a staged overlay, so it does not verify.
      verification: verificationRuns[0],
      overlayCheck: { ok: true, diagnostics: [], at: minutesAgo(3) },
    },
    history: [
      { version: 1, declaration: GET_PRICE_DECLARATION, behaviorNotes: GET_PRICE_NOTES, participants: [SESSION.pricing, SESSION.invoice], at: minutesAgo(27) },
    ],
    createdAt: minutesAgo(27),
    updatedAt: minutesAgo(14),
  },
  {
    id: CONTRACT.receiptLine,
    version: 2,
    title: 'Receipt line format',
    ownerSessionId: SESSION.invoice,
    producerSymbol: 'src/receipt.ts#formatLine:function',
    declaration: 'export declare function formatLine(item: LineItem, unitPriceCents: number): string;',
    behaviorNotes: 'One line per item: quantity, name, then the line total with two decimals.\nNo currency symbol; the receipt header names the currency.',
    participants: [SESSION.invoice, SESSION.pricing],
    acknowledgements: [SESSION.invoice],
    acknowledgementDetails: [{ sessionId: SESSION.invoice, version: 2, intentRevision: 1, at: minutesAgo(11) }],
    intentRevisions: { [SESSION.invoice]: 1, [SESSION.pricing]: 2 },
    status: 'stale',
    evidence: {
      implemented: null,
      verification: null,
      staleReason: 'src/receipt.ts changed outside Hive operations at revision 4, after version 2 was proposed.',
    },
    history: [
      {
        version: 1,
        declaration: 'export declare function formatLine(item: LineItem, unitPrice: number): string;',
        behaviorNotes: 'One line per item: quantity, name, then the line total.',
        participants: [SESSION.invoice, SESSION.pricing],
        at: minutesAgo(21),
      },
      {
        version: 2,
        declaration: 'export declare function formatLine(item: LineItem, unitPriceCents: number): string;',
        behaviorNotes: 'One line per item: quantity, name, then the line total with two decimals.\nNo currency symbol; the receipt header names the currency.',
        participants: [SESSION.invoice, SESSION.pricing],
        at: minutesAgo(12),
      },
    ],
    createdAt: minutesAgo(21),
    updatedAt: minutesAgo(6),
  },
];

const findings: Finding[] = [
  {
    kind: 'assumption_mismatch',
    severity: 'error',
    sessions: [SESSION.pricing, SESSION.invoice],
    source: 'deterministic',
    symbols: ['src/pricing.ts#getPrice:function'],
    files: ['src/pricing.ts'],
    evidence: `src/pricing.ts#getPrice:unit: ${SESSION.pricing} expects cents; ${SESSION.invoice} expects dollars`,
  },
  {
    kind: 'dependent_write',
    severity: 'warning',
    sessions: [SESSION.pricing, SESSION.invoice],
    source: 'compiler',
    symbols: ['src/pricing.ts#getPrice:function'],
    files: ['src/invoice.ts'],
    evidence: `${SESSION.pricing} declares work on src/pricing.ts#getPrice:function (getPrice(sku: string): number); ${SESSION.invoice}'s scope depends on it: src/invoice.ts#lineTotal:function (src/invoice.ts:11)`,
  },
  {
    kind: 'file_overlap',
    severity: 'info',
    sessions: [SESSION.pricing, SESSION.invoice],
    source: 'deterministic',
    files: ['src/invoice.ts'],
    evidence: 'Shared files: src/invoice.ts',
  },
  {
    kind: 'direct_edit',
    severity: 'info',
    sessions: [SESSION.invoice],
    source: 'deterministic',
    files: ['src/receipt.ts'],
    evidence: `Files changed outside Hive operations: src/receipt.ts (detected ${new Date(minutesAgo(6)).toISOString()}, revision 4)`,
  },
];

const events: HiveEvent[] = [
  { seq: 1, at: minutesAgo(41), type: 'revision.bumped', detail: '1: initial index: 42 files indexed', payload: { revision: 1, reason: 'initial index: 42 files indexed' } },
  { seq: 2, at: minutesAgo(36), type: 'session.registered', detail: `Sanika · pricing agent (${SESSION.pricing})`, payload: { sessionId: SESSION.pricing, name: 'Sanika · pricing agent', workspaceId: WORKSPACE_ID } },
  { seq: 3, at: minutesAgo(35), type: 'intent.updated', detail: `${SESSION.pricing}@1: Return integer cents from getPrice`, payload: { sessionId: SESSION.pricing, revision: 1 } },
  { seq: 4, at: minutesAgo(35), type: 'session.registered', detail: `Vishal · invoice agent (${SESSION.invoice})`, payload: { sessionId: SESSION.invoice, name: 'Vishal · invoice agent', workspaceId: WORKSPACE_ID } },
  { seq: 5, at: minutesAgo(34), type: 'intent.updated', detail: `${SESSION.invoice}@1: Build plain-text receipts`, payload: { sessionId: SESSION.invoice, revision: 1 } },
  { seq: 6, at: minutesAgo(30), type: 'session.registered', detail: `Vishal · UI agent (${SESSION.ui})`, payload: { sessionId: SESSION.ui, name: 'Vishal · UI agent', workspaceId: WORKSPACE_ID } },
  { seq: 7, at: minutesAgo(29), type: 'intent.updated', detail: `${SESSION.ui}@1: Rename the export button`, payload: { sessionId: SESSION.ui, revision: 1 } },
  { seq: 8, at: minutesAgo(27), type: 'contract.proposed', detail: `Explicit unit parameter on getPrice (${CONTRACT.getPriceUnit} v1)`, payload: { contractId: CONTRACT.getPriceUnit, version: 1, owner: SESSION.pricing, participants: [SESSION.pricing, SESSION.invoice] } },
  { seq: 9, at: minutesAgo(24), type: 'contract.accepted', detail: `${CONTRACT.getPriceUnit} v1 accepted by all participants`, payload: { contractId: CONTRACT.getPriceUnit, version: 1 } },
  {
    seq: 10, at: minutesAgo(18), type: 'operation.applied',
    detail: `change_signature on src/pricing.ts#getPrice:function by ${SESSION.pricing}: src/pricing.ts, src/invoice.ts (revision 3)`,
    payload: { proposalId: 'prop-2b7e41c0', sessionId: SESSION.pricing, symbol: 'src/pricing.ts#getPrice:function', changedFiles: ['src/pricing.ts', 'src/invoice.ts'], revision: 3 },
  },
  {
    seq: 11, at: minutesAgo(14), type: 'contract.verification_failed',
    detail: `${CONTRACT.getPriceUnit} v1: npm test exited 1 at revision 3`,
    payload: { contractId: CONTRACT.getPriceUnit, runId: 'run-5c1d9e2a', reasons: ['npm test exited 1 at revision 3'] },
  },
  { seq: 12, at: minutesAgo(9), type: 'intent.updated', detail: `${SESSION.pricing}@2: Return integer cents from getPrice`, payload: { sessionId: SESSION.pricing, revision: 2 } },
  { seq: 13, at: minutesAgo(6), type: 'direct_edit', detail: 'Files changed outside Hive operations: src/receipt.ts', payload: { files: ['src/receipt.ts'], workspaceId: WORKSPACE_ID, revision: 4 } },
  {
    seq: 14, at: minutesAgo(6), type: 'contract.stale',
    detail: `${CONTRACT.receiptLine}: src/receipt.ts changed outside Hive operations at revision 4`,
    payload: { contractId: CONTRACT.receiptLine, reason: 'src/receipt.ts changed outside Hive operations at revision 4' },
  },
];

const GET_PRICE_DIFF = [
  '--- a/src/pricing.ts',
  '+++ b/src/pricing.ts',
  '@@ -4,7 +4,10 @@ const catalog: Record<string, number> = {',
  '-export function getPrice(sku: string): number {',
  '-  return catalog[sku] / 100;',
  "+export function getPrice(sku: string, unit: 'cents' | 'dollars'): number {",
  '+  const cents = catalog[sku];',
  "+  if (cents === undefined) throw new RangeError(`Unknown sku: ${sku}`);",
  "+  return unit === 'cents' ? cents : cents / 100;",
  ' }',
  '--- a/src/invoice.ts',
  '+++ b/src/invoice.ts',
  '@@ -9,5 +9,5 @@ export function lineTotal(line: InvoiceLine): number {',
  '-  return getPrice(line.sku) * line.quantity;',
  "+  return getPrice(line.sku, 'dollars') * line.quantity;",
  ' }',
].join('\n');

const proposals: Proposal[] = [
  {
    id: 'prop-2b7e41c0',
    sessionId: SESSION.pricing,
    workspaceId: WORKSPACE_ID,
    baseRevision: 2,
    sourceHashes: { 'src/pricing.ts': HASH.pricingRev3, 'src/invoice.ts': HASH.invoiceRev3 },
    operation: { kind: 'change_signature', symbol: 'src/pricing.ts#getPrice:function', declaration: GET_PRICE_DECLARATION },
    status: 'applied',
    preview: {
      proposalId: 'prop-2b7e41c0',
      sessionId: SESSION.pricing,
      workspaceId: WORKSPACE_ID,
      status: 'applied',
      operation: { kind: 'change_signature', symbol: 'src/pricing.ts#getPrice:function', declaration: GET_PRICE_DECLARATION },
      symbol: 'src/pricing.ts#getPrice:function',
      baseRevision: 2,
      sourceHashes: { 'src/pricing.ts': HASH.pricingRev3, 'src/invoice.ts': HASH.invoiceRev3 },
      affectedFiles: ['src/pricing.ts', 'src/invoice.ts'],
      diff: GET_PRICE_DIFF,
      newDiagnostics: [],
      callers: [{ from: 'src/invoice.ts#lineTotal:function', file: 'src/invoice.ts', line: 11, note: "updated to pass 'dollars'" }],
      rejections: [],
      notes: ['Existing caller keeps dollars so behavior is unchanged until it opts into cents.'],
      createdAt: minutesAgo(19),
    },
    result: { proposalId: 'prop-2b7e41c0', status: 'applied', revision: 3, changedFiles: ['src/pricing.ts', 'src/invoice.ts'], sourceHashes: { 'src/pricing.ts': HASH.pricingRev3, 'src/invoice.ts': HASH.invoiceRev3 }, reasons: [] },
    createdAt: minutesAgo(19),
    updatedAt: minutesAgo(18),
  },
];

export const scenarioAnalysis: Analysis = {
  id: 'analysis-71f0c2d8',
  status: 'ok',
  summary: 'The agreed change to getPrice is applied, but the invoice test still fails: lineTotal returns 19.99 where the test expects 1999. Sanika\'s pricing agent works in integer cents while Vishal\'s invoice agent still asks for dollars, so every invoice line comes out 100 times too small.',
  findings: [
    {
      sessionIds: [SESSION.pricing, SESSION.invoice],
      kind: 'semantic_conflict',
      explanation: 'Revision 3 applied the agreed signature and kept lineTotal in src/invoice.ts on \'dollars\', so it returns 19.99. The invoice test expects integer cents, 1999. The two agents still declare different units for getPrice.',
      evidence: ['src/pricing.ts#getPrice:unit', 'src/invoice.ts#lineTotal:function', 'src/invoice.ts'],
      suggestion: 'Keep the agreed interface. Update lineTotal to ask for \'cents\', apply the staged change that does this, then run npm test again on applied code.',
      proposedDeclaration: GET_PRICE_DECLARATION,
      behaviorNotes: GET_PRICE_NOTES,
      confidence: 'high',
    },
  ],
  model: 'muse-spark-1.3',
  latencyMs: 19828,
  usage: { promptTokens: 1078, completionTokens: 738, totalTokens: 1816 },
  attempts: 1,
  dropped: [],
  inputHash: 'c0a8e4f17b3d9a52',
  revision: 4,
  error: null,
  evidenceRefs: {
    symbols: ['src/pricing.ts#getPrice:function', 'src/invoice.ts#lineTotal:function'],
    files: ['src/pricing.ts', 'src/invoice.ts'],
    sessions: [SESSION.pricing, SESSION.invoice],
    candidates: 2,
  },
  at: minutesAgo(2),
};

/** What the analysis looks like when the model endpoint did not answer. */
export const unavailableAnalysis: Analysis = {
  ...scenarioAnalysis,
  id: 'analysis-9d3b6e05',
  status: 'unavailable',
  summary: '',
  findings: [],
  model: 'muse-spark-1.3',
  latencyMs: null,
  usage: null,
  attempts: 3,
  error: 'The model endpoint did not respond after 3 attempts. Deterministic and compiler findings are unaffected.',
};

export const scenarioSnapshot: ServiceSnapshot = {
  repository: { id: REPOSITORY_ID, canonicalRoot: '/srv/hive/hive-playground', revision: 4 },
  workspaces: [{ id: WORKSPACE_ID, repositoryId: REPOSITORY_ID, realRoot: '/srv/hive/hive-playground', baseCommit: 'a41c9e2' }],
  sessions,
  intents,
  contracts,
  findings,
  events,
  graph: {
    workspaceId: WORKSPACE_ID,
    indexed: true,
    symbols: 214,
    edges: 389,
    files: 42,
    lastSync: { changed: ['src/receipt.ts'], added: [], removed: [] },
  },
  proposals,
  claims: [
    {
      id: 'claim-4a9c1e70',
      rule: { kind: 'field_required', symbol: 'src/receipt.ts#Receipt:interface', field: 'currency', type: 'string', note: 'Receipts name their currency once in the header.' },
      author: `Vishal · invoice agent (${SESSION.invoice})`,
      status: 'active',
      createdAt: minutesAgo(20),
    },
  ],
  analysis: scenarioAnalysis,
  model: { configured: true, model: 'muse-spark-1.3' },
};

/** A freshly connected workspace: indexed, nobody registered yet. */
export const emptySnapshot: ServiceSnapshot = {
  repository: { id: REPOSITORY_ID, canonicalRoot: '/srv/hive/hive-playground', revision: 1 },
  workspaces: scenarioSnapshot.workspaces,
  sessions: [],
  intents: [],
  contracts: [],
  findings: [],
  events: [events[0]],
  graph: { ...scenarioSnapshot.graph, lastSync: null },
  proposals: [],
  claims: [],
  analysis: null,
  model: { configured: true, model: 'muse-spark-1.3' },
};
