---
name: create-worktree
description: Create or inspect a fondaco dev worktree with worktrunk (`wt`) — branch + worktree, copied ignored files, `yarn install`, its own docker compose stack, `.env`/`.env.local` pinned to the worktree's OrbStack domain — then print the URL to open. Use whenever the user asks to spin up / create / make a worktree or branch environment ("worktree for X", "create worktree named X", "new branch env", "wt switch"), asks for the URL or status of an existing worktree, or asks to start a worktree's stack. To tear one down, use `remove-worktree` instead.
---

# fondaco create-worktree

One worktree = one branch + one compose project `fondaco-<branch>` + one OrbStack domain.
Nothing is published to the host, so any number of worktrees run in parallel.

Everything below is already wired in `.config/wt.toml` (hooks + aliases),
`.worktreeinclude` (ignored files copied in), `docker/compose.worktree.yml`
(unpublishes every port) and `scripts/wt-worktree-env.mjs` (pins `.env` +
`.env.local`). The job here is to drive it, wait for the app, and hand back a URL.
Teardown is a separate, destructive job — use the `remove-worktree` skill.

## Naming

| input | value |
|---|---|
| user says `feature/foo` | branch `feature/foo` |
| slug | `feature-foo` — `/` and `\` → `-`, lowercased |
| compose project | `fondaco-feature-foo` |
| app URL | `http://app.fondaco-feature-foo.orb.local` |
| worktree path | sibling of the repo: `<repo>.<slug>` — confirm with `wt list` |

Compute the slug once, reuse it everywhere. Never guess the path — read it from `wt list`.

## Create

1. Preflight (fail fast, from the repo root):

   ```bash
   docker info >/dev/null && git -C <repo> status --porcelain
   ```

   Docker/OrbStack must be up. A dirty tree is fine — the worktree branches from HEAD.

2. Create it. `wt` is a shell function in the user's zsh; call the binary:

   ```bash
   /opt/homebrew/bin/wt -C <repo> switch --create <branch> -y
   ```

   This runs, in order: worktree + branch creation, `wt step copy-ignored`
   (`.env`, `node_modules/`, `.yarn/`, `.mercato/`, `.agents/skills/`, `.mcp.json`),
   `yarn install`, `scripts/wt-worktree-env.mjs <project>`, then
   `docker compose -f docker-compose.fullapp.dev.yml -f docker/compose.worktree.yml up -d`.

   **`wt switch` exits 0 as soon as the worktree exists — the post-start hooks
   keep running detached.** Never read that exit code as "stack is up". Track the
   real work instead:

   ```bash
   pgrep -f 'wt hook run-pipeline'                                  # still running?
   tail -f <repo>/.git/wt/logs/<branch>/project/post-start/deps.log   # yarn install
   tail -f <repo>/.git/wt/logs/<branch>/project/post-start/stack.log  # image build + up -d
   ```

   First run on a machine builds the `dev` image — minutes.

3. Confirm the env is pinned (worktree dir):

   ```bash
   grep -E '^(COMPOSE_PROJECT_NAME|DATABASE_URL)=' .env; cat .env.local
   ```

   `.env.local` must carry `APP_URL=http://app.<project>.orb.local`. It is
   generated, not copied — if it says the wrong project, re-run
   `node scripts/wt-worktree-env.mjs <project>` and restart the app service.

4. Wait for the app. The container installs its own deps, runs
   `init-or-migrate.sh` (DB create + migrate + seed) and only then `yarn dev`, so
   first boot is slow. Poll instead of sleeping:

   ```bash
   for i in $(seq 1 120); do
     code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' http://app.<project>.orb.local/ || true)
     [ "$code" = "200" ] && { echo ready; break; }
     sleep 10
   done
   ```

   While waiting, `wt -y stack logs --tail 40 app` (alias, run inside the
   worktree) shows progress. Report the last decisive log line if it stalls, not
   the whole log.

5. Print the result — URL first, one block, nothing else:

   ```
   http://app.<project>.orb.local
   admin@example.com / password   (OM_INIT_SUPERADMIN_* in .env)
   worktree: <path>   stack: <project>
   ```

## Inspect

- `/opt/homebrew/bin/wt -C <repo> list` — every worktree with its URL column.
- Inside a worktree: `wt -y stack ps`, `wt -y stack logs app`, `wt -y stack restart app`.
  The `stack` alias pins `COMPOSE_PROJECT_NAME` and both compose files and forwards
  everything after it to `docker compose`. `-y` skips the alias approval prompt,
  which cannot be answered non-interactively.

## Attach to Herdr

Herdr models one worktree as its own workspace — it cannot bind a second checkout
into the workspace you are sitting in. `--workspace <id>` only names the source
workspace to inherit the repo from; a new workspace is created either way:

```bash
herdr worktree open --workspace <current id> --path <worktree path>
```

Pass `--path` or `--branch`, never both. The reply carries the new
`workspace_id` and label — report it, and say plainly that a new workspace was
created rather than the current one re-pointed. `herdr workspace focus <id>`
switches to it; `herdr workspace list` shows what exists.

## Optional services

Profiles are off by default. Inside the worktree:

```bash
wt -y stack --profile agents up -d        # opencode + mcp (doubles RAM)
wt -y stack --profile documents-collab up -d
```

`documents-collab` also needs `NEXT_PUBLIC_DOCUMENTS_COLLAB_URL=ws://documents-collab.<project>.orb.local`
appended to `.env.local`.

## Troubleshooting

| symptom | cause / fix |
|---|---|
| domain does not resolve | OrbStack down, or stack not up: `wt -y stack ps`. Image exposes 3000 and 4101 — if the bare domain is ambiguous, use `http://3000.app.<project>.orb.local`. |
| "Blocked cross-origin request to Next.js dev resource" | `.env.local` missing or stale — `APP_ALLOWED_ORIGINS=**.orb.local` must be there. |
| app container restarts on boot | read `wt -y stack logs app`; usually a migration failure — DB is per-project, so `wt -y stack down -v` then `wt -y stack up -d` re-seeds it. |
| port conflict on 3000/4101/4096/3001/4566 | the worktree overlay was dropped from the command; always pass both `-f` files (use the `wt -y stack` alias). |
| host `yarn typecheck`/jest cannot reach the DB | `.env` `DATABASE_URL` must point at `postgres.<project>.orb.local:5432`. |
