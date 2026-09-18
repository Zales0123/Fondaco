---
name: remove-worktree
description: Tear down a fondaco dev worktree created with worktrunk (`wt`) — stop and delete its docker compose stack and volumes, remove the worktree directory, and delete the branch when it is merged. Use whenever the user asks to remove / delete / tear down / clean up a worktree or branch environment ("remove worktree X", "kill that stack", "clean up finished worktrees", "wt remove"), or asks which worktrees can be dropped. To create one, use `create-worktree` instead.
---

# fondaco remove-worktree

Removal is **destructive and not undoable**: the pre-remove hooks run
`down -v --remove-orphans` against both the fullapp and the infra compose project,
so the worktree's Postgres data, Redis, Meilisearch index and attachment storage
are deleted with it. Uncommitted work in the worktree dies too unless it is
committed or pushed first.

Never remove a worktree the user did not name. Never widen a named removal into
"and the other stale ones".

## Naming

| input | value |
|---|---|
| user says `feature/foo` | branch `feature/foo` |
| slug | `feature-foo` — `/` and `\` → `-`, lowercased |
| compose project | `fondaco-feature-foo` |
| worktree path | read it from `wt list`, never guess |

## Steps

1. Resolve the target and show what will die:

   ```bash
   /opt/homebrew/bin/wt -C <repo> list
   git -C <worktree> status --porcelain
   git -C <worktree> log --oneline @{u}.. 2>/dev/null || git -C <worktree> log --oneline main..
   ```

   Report, in one block: worktree path, branch, compose project, uncommitted
   files, unpushed commits. Then confirm with the user before step 2 — always,
   even when they already said "remove it", if there is uncommitted or unpushed
   work. State plainly that the database and volumes go with it.

2. Remove:

   ```bash
   /opt/homebrew/bin/wt -C <repo> remove <branch> --foreground -y
   ```

   - `--foreground` blocks until the pre-remove hooks finish; without it removal
     is backgrounded and any report of success is a guess.
   - `-D` deletes an unmerged branch — only with the user's explicit yes.
   - `-f` removes a dirty worktree (staged, modified, untracked files) — only
     with the user's explicit yes.
   - `--no-delete-branch` keeps the branch and drops only the worktree + stack.
     Offer this when the branch is unmerged but the user only wants the disk and
     RAM back.

   Removing the *current* worktree is fine from the repo root; do not run it with
   `-C <worktree>` pointed at the directory being deleted.

3. Verify nothing is left behind:

   ```bash
   docker compose ls -a | grep fondaco-<slug> || echo "no stack"
   docker volume ls -q | grep '^fondaco-<slug>' || echo "no volumes"
   /opt/homebrew/bin/wt -C <repo> list
   git -C <repo> branch --list <branch>
   ```

   All four should come back empty. Report what actually remains rather than
   claiming a clean teardown.

4. Report: what was removed (worktree path, branch, compose project), whether the
   branch was deleted or kept, and anything left over on purpose.

## Leftovers

Worktree directory deleted by hand, so the hooks never ran:

```bash
git -C <repo> worktree prune
COMPOSE_PROJECT_NAME=fondaco-<slug> docker compose -f <repo>/docker-compose.fullapp.dev.yml -f <repo>/docker/compose.worktree.yml down -v --remove-orphans
COMPOSE_PROJECT_NAME=fondaco-<slug> docker compose -f <repo>/docker-compose.yml --profile agents down -v --remove-orphans
```

Both files must be passed together — the overlay is what unpublishes the ports.
If the compose project is gone but volumes survive, delete them by exact name
(`docker volume rm fondaco-<slug>_postgres_data ...`); never `docker volume prune`,
which would take the other worktrees' data with it.

## Do not

- Do not remove `main`'s worktree or the repo root.
- Do not `docker system prune` / `docker volume prune` to clean up — other
  worktrees and the main stack share the daemon.
- Do not delete a branch that is unmerged and unpushed without the user saying so
  in this session.
