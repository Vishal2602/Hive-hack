import { readFileSync } from 'node:fs';
import { ts } from 'ts-morph';

/**
 * Laptop scripts served by the daemon without authentication (they contain no secrets):
 * /hook.mjs is the client hook as one plain-JavaScript file, /connect.mjs the one-time setup.
 * Built from the TypeScript sources on first request so laptops need only Node 18+, not a Hive checkout.
 */
const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const RELATIVE_IMPORT = /^import\s[^;]*from\s+'\.{1,2}\/[^']*';\s*$/gm;

function toJs(code: string, name: string): string {
  const output = ts.transpileModule(code, { fileName: name, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: false } });
  return output.outputText;
}

let hook: string | null = null;
export function hookScript(): string {
  // client.ts and paths.ts have no imports of their own; hook.ts's relative imports are replaced by their text.
  hook ??= toJs([`// Hive client hook (generated from src/hooks/hook.ts). Usage: node hive-hook.mjs <event> --client claude`,
    source('./client.ts'), source('../remote/paths.ts'), source('../hooks/hook.ts').replace(RELATIVE_IMPORT, '')].join('\n'), 'hive-hook.ts');
  return hook;
}

export function connectScript(hubUrl: string): string {
  return toJs(source('../hooks/connect.ts').replace("'__HIVE_URL__'", JSON.stringify(hubUrl.replace(/\/+$/, ''))), 'hive-connect.ts');
}
