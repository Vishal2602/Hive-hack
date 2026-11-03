/**
 * Shared setup for the scripted demo and the evaluation harness.
 * Everything runs on a throw-away temp copy of fixtures/billing; nothing in the repo is modified.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IntentInput } from '../src/domain/types.ts';
import type { Analyzer } from '../src/intelligence/types.ts';
import { HiveService } from '../src/service.ts';
import { Store } from '../src/store/sqlite.ts';

export const FIXTURE = fileURLToPath(new URL('../fixtures/billing/', import.meta.url));
export const PRODUCER = 'src/pricing.ts#getPrice:function';
export const DECLARATION = "export declare function getPrice(unit: 'cents' | 'dollars'): number;";
export const CHANGE_SIGNATURE = { kind: 'change_signature' as const, symbol: PRODUCER, declaration: "getPrice(unit: 'cents' | 'dollars'): number" };
export const TEST_COMMAND = 'node --test tests/pricing.test.ts';
/** Behavior check that is meaningful even when nobody touches pricing (the cents test encodes the unit-change target). */
export const INVOICE_TEST_ARGS = ['--test', '--test-name-pattern=invoice keeps rendering dollars', 'tests/pricing.test.ts'];

export const INTENTS = {
  pricing: { task: 'Make getPrice explicit about units (cents)', files: ['src/pricing.ts'], symbols: [PRODUCER], assumptions: [{ key: 'src/pricing.ts#getPrice:unit', value: 'cents' }] },
  invoice: { task: 'Export invoices', files: ['src/invoice.ts'], symbols: ['src/invoice.ts#invoiceTotal:function'], assumptions: [{ key: 'src/pricing.ts#getPrice:unit', value: 'dollars' }] },
  ui: { task: 'Change button label', files: ['src/button.ts'], symbols: ['src/button.ts#buttonLabel:variable'], assumptions: [] },
} satisfies Record<string, IntentInput>;

/** The edits each "agent" makes. In this replay they are performed by the script, not by live agents. */
export const EDITS = {
  consumerAdapted: "import { getPrice } from './pricing.ts';\nimport { applyTax } from './tax.ts';\nexport function invoiceTotal(): string { return `$${(getPrice('cents') / 100).toFixed(2)}`; }\nexport function invoiceWithTax(): number { return applyTax(getPrice('dollars'), 0.2, 'EU'); }\n",
  producerBody: "/** Unit is explicit. 'cents' returns integer USD cents. */\nexport function getPrice(unit: 'cents' | 'dollars'): number { return unit === 'cents' ? 1999 : 19.99; }\n",
  /** Unit change without a signature change: a number is a number, so the compiler cannot see it. */
  producerSilentCents: "/** Returns integer USD cents. */\nexport function getPrice(): number { return 1999; }\n",
  uiLabel: "export const buttonLabel = 'Download invoice';\n",
};

export interface Workspace {
  dir: string;
  dbPath: string;
  service: HiveService;
  write(file: string, text: string): void;
  read(file: string): string;
  cleanup(): void;
}

export function workspace(prefix: string, analyzer?: Analyzer): Workspace {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cpSync(FIXTURE, dir, { recursive: true });
  const dbPath = join(dir, '.hive', 'hive.db');
  const store = new Store(dbPath);
  const service = new HiveService({ store, root: dir, ...(analyzer ? { analyzer } : {}) });
  return {
    dir, dbPath, service,
    write: (file, text) => writeFileSync(join(dir, file), text),
    read: file => readFileSync(join(dir, file), 'utf8'),
    cleanup: () => { try { store.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); },
  };
}

export interface CommandResult { command: string; exitCode: number; output: string }
/** Runs `node` with fixed args in the workspace (no shell). Strips inherited test-runner context. */
export function runNode(dir: string, args: string[]): CommandResult {
  const env: Record<string, string | undefined> = { ...process.env, MODEL_API_KEY: '', HIVE_TOKEN: '' };
  delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS;
  const proc = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8', timeout: 120_000, env });
  return { command: `node ${args.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`, exitCode: proc.status ?? 1, output: `${proc.stdout ?? ''}${proc.stderr ?? ''}` };
}

export interface TypeDiagnostic { file: string; line: number; code: number; message: string }
/** Whole-project type-check through the compiler index (offline; no tsc binary needed). */
export function typeCheck(service: HiveService): TypeDiagnostic[] {
  const graph = service.graph();
  return graph.openProject().getPreEmitDiagnostics().map(d => {
    const text = d.getMessageText();
    const message = typeof text === 'string' ? text : text.getMessageText();
    const source = d.getSourceFile();
    return { file: source ? graph.rel(source.getFilePath()) : '(global)', line: d.getLineNumber() ?? 0, code: d.getCode(), message };
  });
}

/** The assertion line of a failing node:test run, e.g. "19.99 !== 1999" plus the failing test name. */
export function assertionLine(output: string): string | null {
  const lines = output.split('\n').map(l => l.trim());
  const failed = lines.find(l => l.startsWith('not ok '));
  const actual = lines.find(l => l.startsWith('actual:'));
  const expected = lines.find(l => l.startsWith('expected:'));
  const values = lines.find(l => / !== /.test(l)) ?? (actual && expected ? `${actual}, ${expected}` : undefined);
  if (!failed && !values) return null;
  return [values, failed ? `(${failed})` : null].filter(Boolean).join(' ');
}
