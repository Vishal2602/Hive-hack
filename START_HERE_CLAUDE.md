Build Hive from this fresh starter into a working local multi-agent coordination demo.

First read README.md, CLAUDE.md, docs/PRODUCT.md, docs/ARCHITECTURE.md,
docs/BUILD_PLAN.md, docs/ACCEPTANCE.md and VERIFICATION.md. Inspect the code.
Run the existing tests and type check. Then implement the phases in order.
Do not stop after giving me a plan. Make the actual code changes, run relevant tests,
and keep docs/PROGRESS.md updated with what works and what remains.

The goal: two real coding agents register plans, Hive finds an incompatible shared
interface or assumption, proposes a Ghost Contract, both agents acknowledge it,
continue working, and a combined test verifies their implementations fit. An
unrelated third agent should continue without unnecessary blocking.

Use Muse Spark for interpreting plans and proposing resolutions. Use TypeScript
compiler information and deterministic code for checks and writes. Muse Code is
our first demo client; verify its installed MCP/hook behavior rather than guessing.
Claude Code is helping build Hive; it is not a required runtime model for Hive.

Preserve the working starter but replace temporary components as specified. Build
persistent storage, real symbol/dependency indexing, staged semantic operations,
versioned Ghost Contracts, model analysis with evidence, a reliable checkpoint
integration and a small local dashboard. Start with one complete path; expand only
when it works. Do not fake success or label agreement as verified implementation.

You may reuse concepts from the previous Hive, but this is a clean rebuild. This
folder contains no original source. Ask me only for genuinely missing access or
product decisions that block progress. Continue independent work while access is
missing. Finish by giving exact run commands, test results, limitations, and the
remaining steps to record the demo. Do not publish the repo or package.
