# hive-playground

A small TypeScript billing app used to try Hive with real coding agents. Prices are stored and
computed in US dollars as decimals today. The repository is deliberately simple: a catalog,
pricing, tax, invoice formatting, and two UI labels, plus a passing test suite.

## Run
```bash
npm install
npm test
npm run typecheck
```

## Try Hive with real agents
1. In the Hive container this checkout lives at `/data/repo` and the daemon already runs
   against it (`deploy/entrypoint.sh`). Locally: `HIVE_PROJECT_ROOT=<this folder> npm start`
   from the Hive repo.
2. Open the dashboard at `<Hive URL>/ui` and sign in with your Hive token.
3. Open two or three coding-agent sessions in this folder. `.mcp.json` and
   `.claude/settings.json` already connect Claude Code to Hive (paths assume Hive at `/app` and
   HIVE_TOKEN / HIVE_URL in the environment); `.muse/hooks.json` is a
   best-guess template for Muse Code.
4. Give each agent one of the tasks below. They collide on the price unit by design.

### Agent tasks
- **Pricing agent:** "Money bugs keep appearing from floating point. Change pricing so that
  `getPrice` returns integer cents instead of decimal dollars, and update the catalog and
  `applyDiscount` accordingly. Keep tests green."
- **Invoice agent:** "Add a `buildReceipt(invoice)` function in `src/invoice.ts` that returns a
  plain-text receipt with one line per item and the total in dollars, and add tests for it."
- **UI agent:** "Rename the export button label to 'Download invoice' and add a
  `cancelButtonLabel`. Add a test for `renderButton`."

The pricing and invoice agents share `getPrice` and disagree about its unit. Hive should raise
the finding, one agent should propose a Ghost Contract (for example an explicit `unit`
parameter or a new `getPriceCents` function), both should acknowledge it, and `npm test`
against the real code is what finally verifies it. The UI agent should never be blocked.
