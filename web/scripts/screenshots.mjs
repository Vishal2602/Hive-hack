// Design review screenshots: every route x theme x width, plus Demo state variants on /.
// Usage: node scripts/screenshots.mjs [baseUrl] [outDir]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const OUT = resolve(process.argv[3] ?? 'screenshots/round3');
const TOKEN = 'hive_adm_4Wq8demoTokenForThePrototypeOnly';
const FIRST_AGREEMENT = 'a2c4e6f8-1b3d-4f5a-8c7e-9d0b1a2c3e55';
const ROUTES = [
  ['signin', '/signin', false],
  ['connect', '/connect', true],
  ['overview', '/', true],
  ['agreements', '/agreements', true],
  ['agreement-detail', `/agreements/${FIRST_AGREEMENT}`, true],
  ['activity', '/activity', true],
  ['members', '/members', true],
];
const THEMES = ['light', 'dark'];
const WIDTHS = [390, 820, 1440];

mkdirSync(OUT, { recursive: true });
const report = { pages: [] };
const browser = await chromium.launch();

async function openPage({ theme, width, signedIn }) {
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  await context.addInitScript(([t, token, signed]) => {
    try { localStorage.setItem('hive.theme', t); } catch {}
    try { if (signed) sessionStorage.setItem('hive.session-token', token); else sessionStorage.removeItem('hive.session-token'); } catch {}
    try { if (document.documentElement) document.documentElement.dataset.theme = t; } catch {}
  }, [theme, TOKEN, signedIn]);
  const page = await context.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  const requests = [];
  page.on('request', r => { const u = r.url(); if (!u.startsWith(BASE) && !u.startsWith('data:')) requests.push(u); });
  return { context, page, errors, requests };
}

async function measure(page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    theme: document.documentElement.dataset.theme,
    path: location.pathname,
    conflictTop: (() => { const h = [...document.querySelectorAll('h2,h3')].find(e => /conflict|disagree|assumption/i.test(e.textContent || '')); return h ? Math.round(h.getBoundingClientRect().top + scrollY) : null; })(),
    conflictText: (() => { const h = [...document.querySelectorAll('h2,h3')].find(e => /conflict|disagree|assumption/i.test(e.textContent || '')); return h ? h.textContent : null; })(),
  }));
}

for (const [slug, path, signedIn] of ROUTES) {
  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      const { context, page, errors, requests } = await openPage({ theme, width, signedIn: signedIn || slug === 'signin' ? signedIn : false });
      await page.goto(BASE + path, { waitUntil: 'networkidle' });
      await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
      await page.waitForTimeout(600);
      const file = `${slug}_${theme}_${width}.png`;
      await page.screenshot({ path: `${OUT}/${file}`, fullPage: true });
      const m = await measure(page);
      report.pages.push({ file, path, ...m, horizontalOverflow: m.scrollWidth > m.clientWidth, errors, externalRequests: requests });
      await context.close();
    }
  }
}

// Demo state variants on / at 1440 light.
const VARIANTS = [
  ['offline', 'Offline'],
  ['stale', 'Updates delayed'],
  ['model-unavailable', 'Model unavailable'],
  ['model-not-configured', 'Model not configured'],
  ['empty', 'Empty workspace'],
];
for (const [slug, label] of VARIANTS) {
  for (const route of [['overview', '/']].concat(slug === 'empty' ? [['agreements', '/agreements'], ['activity', '/activity'], ['members', '/members']] : [])) {
    const { context, page, errors, requests } = await openPage({ theme: 'light', width: 1440, signedIn: true });
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /Demo state/ }).click();
    await page.getByRole('menuitem', { name: label }).click();
    await page.waitForTimeout(400);
    if (route[1] !== '/') {
      await page.evaluate(p => { history.pushState({}, '', p); dispatchEvent(new PopStateEvent('popstate')); }, route[1]);
      await page.waitForTimeout(500);
    }
    const file = `variant-${slug}_${route[0]}_light_1440.png`;
    await page.screenshot({ path: `${OUT}/${file}`, fullPage: true });
    const m = await measure(page);
    report.pages.push({ file, path: route[1], ...m, horizontalOverflow: m.scrollWidth > m.clientWidth, errors, externalRequests: requests });
    await context.close();
  }
}

// Activity events with a diff and with test output, 1440 and 390 light/dark.
for (const [seq, slug] of [[10, 'diff'], [11, 'test-output']]) {
  for (const theme of THEMES) {
    for (const width of [390, 1440]) {
      const { context, page, errors, requests } = await openPage({ theme, width, signedIn: true });
      await page.goto(`${BASE}/activity?event=${seq}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(600);
      const file = `activity-${slug}_${theme}_${width}.png`;
      await page.screenshot({ path: `${OUT}/${file}`, fullPage: true });
      const m = await measure(page);
      report.pages.push({ file, path: `/activity?event=${seq}`, ...m, horizontalOverflow: m.scrollWidth > m.clientWidth, errors, externalRequests: requests });
      await context.close();
    }
  }
}

// Connect flow: step 2 form, generated token + snippet, step 3 waiting, then simulated registration.
for (const theme of THEMES) {
  for (const width of WIDTHS) {
    const { context, page, errors, requests } = await openPage({ theme, width, signedIn: true });
    const shot = async name => {
      await page.waitForTimeout(500);
      const file = `connect-${name}_${theme}_${width}.png`;
      await page.screenshot({ path: `${OUT}/${file}`, fullPage: true });
      const m = await measure(page);
      report.pages.push({ file, path: '/connect', ...m, horizontalOverflow: m.scrollWidth > m.clientWidth, errors: [...errors], externalRequests: [...requests] });
    };
    try {
      await page.goto(BASE + '/connect', { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: /Continue/ }).click();
      await shot('step2-form');
      await page.getByLabel('Name').fill('Priya');
      await page.getByRole('button', { name: 'Generate token' }).click();
      await shot('step2-token');
      await page.getByRole('button', { name: /Wait for/ }).click();
      await shot('step3-waiting');
      const sim = page.getByRole('button', { name: 'Simulate agent registering' });
      if (await sim.count()) { await sim.click(); await page.waitForTimeout(4000); }
      await shot('step3-done');
    } catch (e) {
      report.pages.push({ file: `connect-flow_${theme}_${width}`, path: '/connect', errors: [...errors, `flow: ${e.message.split('\n')[0]}`], externalRequests: requests });
    }
    await context.close();
  }
}

// /join#token=... lands signed in.
{
  const { context, page, errors, requests } = await openPage({ theme: 'light', width: 1440, signedIn: false });
  await page.goto(`${BASE}/join#token=${TOKEN}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const file = 'join_light_1440.png';
  await page.screenshot({ path: `${OUT}/${file}`, fullPage: true });
  const m = await measure(page);
  report.pages.push({ file, path: '/join#token=…', ...m, finalHash: await page.evaluate(() => location.hash), errors, externalRequests: requests });
  await context.close();
}

await browser.close();
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
const bad = report.pages.filter(p => p.errors.length || p.horizontalOverflow || p.externalRequests.length);
console.log(`captured ${report.pages.length} pages; ${bad.length} with errors, overflow or external requests`);
for (const p of bad) console.log(p.file, p.horizontalOverflow ? `overflow ${p.scrollWidth}>${p.clientWidth}` : '', p.errors.slice(0, 3), p.externalRequests.slice(0, 3));
