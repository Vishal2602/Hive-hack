import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';

/**
 * Serves the built React app (web/dist, Vite base '/ui/') at /ui with an SPA fallback to index.html.
 * The bundle is static and secret-free; it reads the Bearer token from sessionStorage at runtime.
 * '/' and '/join' redirect into /ui (invite links put the token in the #fragment, which survives
 * the redirect and never reaches the server). Only GET and HEAD are handled here; anything else
 * falls through to the authenticated routes.
 */
export const UI_BUILD_COMMAND = 'npm run build:web';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } as const;

/** sha256 CSP sources for every inline <script> (no src) in an HTML document. */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/.test(match[1] ?? '')) continue;
    hashes.push(`'sha256-${createHash('sha256').update(match[2] ?? '', 'utf8').digest('base64')}'`);
  }
  return hashes;
}

/** CSP for the app: same-origin assets and API, inline scripts only by hash, inline styles allowed (React style props). */
export function uiCsp(html: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${inlineScriptHashes(html).join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const MISSING_PAGE = (dist: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hive dashboard not built</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#222}code{background:#f2f2f2;padding:.1rem .35rem;border-radius:4px}</style>
</head><body>
<h1>The Hive dashboard is not built</h1>
<p>The daemon is running, but there is no web build at <code>${escapeHtml(dist)}</code>.</p>
<p>From the Hive repository run <code>${UI_BUILD_COMMAND}</code>, then reload this page. The API, <code>/healthz</code> and <code>/mcp</code> work without it.</p>
</body></html>`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

export interface UiHandler {
  /** Returns true when the request was answered. */
  handle(request: IncomingMessage, response: ServerResponse, pathname: string): boolean;
  readonly dist: string;
}

export function createUiHandler(distDir: string): UiHandler {
  const dist = resolve(distDir);
  let indexCache: { mtimeMs: number; size: number; html: Buffer; csp: string } | null = null;

  const readIndex = () => {
    const file = resolve(dist, 'index.html');
    const stat = statSync(file);
    if (!indexCache || indexCache.mtimeMs !== stat.mtimeMs || indexCache.size !== stat.size) {
      const html = readFileSync(file);
      indexCache = { mtimeMs: stat.mtimeMs, size: stat.size, html, csp: uiCsp(html.toString('utf8')) };
    }
    return indexCache;
  };

  /** Real path of a file inside dist (symlinks resolved), or null when missing, a directory, or outside dist. */
  const resolveAsset = (relative: string): string | null => {
    const candidate = resolve(dist, relative);
    if (candidate !== dist && !candidate.startsWith(dist + sep)) return null;
    try {
      const realDist = realpathSync(dist);
      const real = realpathSync(candidate);
      if (!real.startsWith(realDist + sep)) return null;
      return statSync(real).isFile() ? real : null;
    } catch { return null; }
  };

  const send = (request: IncomingMessage, response: ServerResponse, status: number, headers: Record<string, string>, body: Buffer | string) => {
    response.writeHead(status, { ...SECURITY_HEADERS, ...headers, 'Content-Length': String(Buffer.byteLength(body)) });
    response.end(request.method === 'HEAD' ? undefined : body);
  };

  const sendIndex = (request: IncomingMessage, response: ServerResponse) => {
    const index = readIndex();
    send(request, response, 200, { 'Content-Type': CONTENT_TYPES['.html']!, 'Content-Security-Policy': index.csp, 'Cache-Control': 'no-cache' }, index.html);
  };

  return {
    dist,
    handle(request, response, pathname) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return false;
      if (pathname === '/' || pathname === '/join') {
        response.writeHead(302, { ...SECURITY_HEADERS, Location: pathname === '/' ? '/ui/' : '/ui/join', 'Cache-Control': 'no-store' }).end();
        return true;
      }
      if (pathname !== '/ui' && !pathname.startsWith('/ui/')) return false;
      if (!existsSync(resolve(dist, 'index.html'))) {
        console.error(`Hive: dashboard requested but ${dist}/index.html is missing; run ${UI_BUILD_COMMAND}`);
        send(request, response, 503, { 'Content-Type': CONTENT_TYPES['.html']!, 'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" }, MISSING_PAGE(dist));
        return true;
      }
      let relative: string;
      try { relative = decodeURIComponent(pathname.slice('/ui/'.length)); } catch {
        send(request, response, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Bad request'); return true;
      }
      if (relative.includes('\0') || relative.split(/[\\/]/).includes('..')) {
        send(request, response, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found'); return true;
      }
      if (relative === '' || relative === 'index.html') { sendIndex(request, response); return true; }
      const file = resolveAsset(relative);
      if (file) {
        const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
        // Vite fingerprints everything under assets/; other files (favicon) revalidate.
        const cache = relative.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
        send(request, response, 200, { 'Content-Type': type, 'Cache-Control': cache }, readFileSync(file));
        return true;
      }
      // A missing file with an extension is a real 404 (a stale asset URL must not get HTML); routes get the app.
      const last = relative.split('/').pop() ?? '';
      if (/\.[A-Za-z0-9]{1,8}$/.test(last)) {
        send(request, response, 404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, 'Not found'); return true;
      }
      sendIndex(request, response);
      return true;
    },
  };
}
