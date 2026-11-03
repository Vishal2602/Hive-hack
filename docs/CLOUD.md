# Running Hive in the cloud: components and options

Status: decision document, 2026-11-02. Nothing here is deployed yet. Hive today runs as one
local process bound to 127.0.0.1 with a shared token. This page lists what a hosted Hive needs,
compares the hosting options, and recommends a path for the hackathon submission (Nov 4, 9 PM ET)
and a separate path for a real team deployment.

## Why Hive cannot simply be "a website"

Hive does two kinds of work:

1. Bookkeeping: members, tokens, agent sessions, intents, findings, Ghost Contracts, events.
   This could live on any server or database.
2. Code checking: running the TypeScript compiler over the repository to build the symbol and
   dependency index, staging edits in memory, writing files with a journal, and running an
   allowlisted test command. This must run on a machine that has the repository files.

So the server that does the checking has to sit next to a clone of the repository. Members and
their coding agents can be anywhere; they reach Hive over HTTPS with a token.

## Component inventory

| # | Component | Purpose | Hackathon setup (by Nov 4) | Team / enterprise setup | Status today |
|---|---|---|---|---|---|
| 1 | Compute for the Hive server | Runs the daemon: API, SQLite, compiler index, staged edits, test runs | Your Mac, a GitHub Codespace, or one small VM/container | One container per repository behind a load balancer, or a hub plus local nodes | Local only |
| 2 | Repository checkout on that compute | Hive must see the files it checks and edits | The clone on your Mac, or the clone inside the Codespace/VM | Integration clone synced by CI; worktrees per agent | Local clone |
| 3 | Public URL and TLS | Members and agents reach Hive from anywhere over HTTPS | Codespaces port forwarding, Cloudflare tunnel, or the provider's domain | Own domain, managed certificate, WAF | Missing |
| 4 | Persistent storage | Sessions, intents, contracts, events, tokens survive restarts | SQLite file in `.hive/` on the same disk | Volume with backups, or Postgres for many repos | Done (SQLite) |
| 5 | Secrets store | Bootstrap token and the model API key | `.env` on the host | Provider secrets manager or Vault | Done (`.env`) |
| 6 | Identity and access | Who may connect, with what role | Hive-issued member tokens from the dashboard (admin, member, viewer) | SSO via OIDC (Okta, Google, Entra), short-lived tokens, audit export | Single shared token; member tokens are the planned backend change |
| 7 | Agent runtime | Where coding agents run and edit files | Laptops for intents and agreements; the machine with the integration clone for compiler-verified work; or everyone inside one Codespace | Cloud dev environments or CI runners next to the integration clone | Laptops |
| 8 | Model API | Muse Spark analysis | Meta Model API with the existing key | Same, with team billing and rate limits | Done (one live smoke call succeeded on 2026-11-02; result not stored in the repo) |
| 9 | Source hosting | Public repo for the submission and clone source | GitHub (`gh` is logged in) | GitHub/GitLab org with branch protection | Not yet a git repo |
| 10 | Dashboard hosting | Serves the React app | Served by the Hive daemon itself | Same, or a CDN in front | Daemon serves `/ui` |
| 11 | Container image | Repeatable deploy of Hive plus Node 22 | Dockerfile built locally (Docker installed) | Image registry, signed images | Missing |
| 12 | Monitoring and logs | Know the server is up, see errors | Daemon stderr plus the dashboard's offline state | Log shipping, uptime checks, alerts | Minimal |
| 13 | Backups | Recover state | Copy of `.hive/` | Scheduled volume snapshots | Manual |

Nothing on the hackathon path needs a new paid account: Codespaces and the tunnel are free at
this scale, SQLite and secrets are files, GitHub and the Meta key exist.

## Hosting options compared

| Option | What it is | Fits Hive as built? | What changes | Account / cost | Time to first public link | Best for |
|---|---|---|---|---|---|---|
| GitHub Codespaces | A cloud VM with the repo cloned and Node installed; a forwarded port can be made public with HTTPS | Yes, unchanged (port forwarding reaches the loopback bind) | Run `npm start` inside the Codespace; set port 4317 to public; agents can run inside the same Codespace | Existing GitHub account; free personal hours (check current quota) | ~15 minutes | Genuinely hosted demo where both teammates' agents sit next to the files |
| Cloudflare tunnel | A small program on your Mac that gives the local server a public HTTPS URL | Yes, unchanged | `brew install cloudflared`, one command; Hive stays bound to loopback | Free, no account for quick tunnels | ~5 minutes | Lowest-risk demo; link dies when the laptop sleeps |
| Fly.io / Railway / Render / Hetzner / DigitalOcean / AWS Lightsail | Container or VM platforms that run a long-lived process with a persistent volume | Yes, with one code change: the daemon binds only to 127.0.0.1 (`src/server/daemon.ts`), so a bind-address option is required behind a platform proxy | Dockerfile, bind-address option, volume for `.hive/` and the repo clone, env vars for secrets | Account; Railway/Render have starter tiers, Fly needs a card, big clouds need more setup | 1 to 3 hours | Permanent URL for a team, no laptop dependency |
| Vercel / Netlify / Cloudflare Workers | Function platforms: short per-request code, no persistent disk | No, not as built (default 300 s per function, 800 s with Fluid Compute on paid plans, no long-lived process or local disk) | Redesign: bookkeeping as functions on Vercel Postgres or Neon; compiler and tests as jobs in Vercel Sandbox that clone the repo at a revision; dashboard as a static site | Vercel account (CLI already installed) | Days, not hours | Future cloud-native architecture; the static dashboard alone could be hosted here any time |

## Recommendation

For Nov 4, ranked:

1. **GitHub Codespaces** if you want Hive and both agents truly in the cloud and shared with a
   partner. Everything stays next to the repo, the URL is HTTPS, and no new account is needed.
2. **Cloudflare tunnel** if you want the least that can go wrong during a recording.
3. **Railway or Fly container** if you want a permanent URL and are willing to create an account
   tonight.
4. **Vercel** only as the documented next architecture, not for this submission.

For a team deployment after the hackathon: one Hive container per repository on a VM or
container platform with a volume, member tokens issued from the dashboard, then SSO. The long-term
shape is a hosted Hive hub (bookkeeping, members, dashboards for many repos) plus a light local
Hive node next to each integration clone that does the compiler work and reports to the hub.

## Setup outlines

### Codespaces
1. Push the Hive repo and the target repo to GitHub.
2. Open a Codespace on the target repo; clone Hive beside it or add it as a submodule.
3. `npm install` in Hive, copy `.env` values into Codespace secrets (`HIVE_TOKEN`, `MODEL_API_KEY`).
4. `HIVE_PROJECT_ROOT=/workspaces/<target> npm start`, then set port 4317 visibility to Public.
5. Share `https://<codespace>-4317.app.github.dev` plus member tokens; agents run in Codespace terminals.

### Cloudflare tunnel
1. `brew install cloudflared`.
2. `npm start` in Hive with `HIVE_PROJECT_ROOT` set to the repo.
3. `cloudflared tunnel --url http://127.0.0.1:4317` and share the printed `https://*.trycloudflare.com` URL.

### Container (Fly.io, Railway, Render)
1. Add a Dockerfile: `node:22-bookworm`, copy Hive, `npm ci`, clone the target repo onto a mounted volume.
2. Mount a volume at `/data` and set `HIVE_DATA_DIR=/data/.hive`, `HIVE_PROJECT_ROOT=/data/repo`.
3. Set `HIVE_TOKEN` and `MODEL_API_KEY` as platform secrets; expose port 4317 behind the platform's HTTPS.
4. Run coding agents on that machine (SSH or the platform console) so edits land in the same clone.

## Open decisions

- Which option for Nov 4 (owner: Vishal).
- Member tokens and roles in the backend (owner: build team; scoped, not started).
- Binding beyond loopback is only needed for the container path; the tunnel and Codespaces work with the current loopback binding.
- See `HIVE_CLOUD_HANDOFF.md` (2026-11-02) for the code-verified inventory, including the blocking-verify and multi-instance issues that any hosted setup must address.
