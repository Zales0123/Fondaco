# Docker development setup

Setup notes for running the development stack with
`docker-compose.fullapp.dev.yml`.

## Start the stack

Prepare the local environment once:

```sh
cp .env.example .env
yarn install
```

Build and start the stack:

```sh
docker compose -f docker-compose.fullapp.dev.yml up --build
```

No container publishes a host port (see "No published ports" below), so reach
the app from inside the compose network, for example:

```sh
docker compose -f docker-compose.fullapp.dev.yml exec app curl -fsS http://app:3000/
```

To stop it without deleting database or application volumes:

```sh
docker compose -f docker-compose.fullapp.dev.yml down
```

Do not add `--volumes` unless the persisted development data should be deleted.

## No published ports

`docker-compose.yml`, `docker-compose.fullapp.yml` and
`docker-compose.fullapp.dev.yml` declare no `ports:` mappings. Nothing binds a
host port, so several stacks can run side by side and no service is reachable
from outside the Docker network.

Consequences:

- The app, Postgres, Redis, Meilisearch, OpenCode, MCP and LocalStack are
  reachable only by service name on the compose network
  (`app:3000`, `postgres:5432`, `redis:6379`, `meilisearch:7700`,
  `opencode:4096`, `mcp:3001`, `localstack:4566`).
- Host access needs either a temporary `ports:` entry, `docker compose exec`,
  or a reverse proxy attached to `mercato-network-fullapp`.

All inter-service configuration uses service DNS: `DATABASE_URL`,
`REDIS_URL`/`CACHE_REDIS_URL`, `MEILISEARCH_HOST`, `OPENCODE_MCP_URL`, the MCP
sidecar's `APP_URL`/`NEXT_PUBLIC_APP_URL`/`INTERNAL_APP_ORIGIN` and
`LOCALSTACK_HOST`. `APP_URL` on the `app` and `documents-collab` services stays
`http://localhost:3000` because it is a browser origin used for the collab
origin allowlist, not a container-to-container address.

## Local overrides and OrbStack domains

Env layering for the dev stack, lowest priority first:

1. `.env` — shared defaults, gitignored, copied into new worktrees.
2. `.env.local` — per-developer / per-worktree overrides, gitignored.
   Start from `.env.local.example`.
3. `environment:` in the compose file — container-network pins
   (`DATABASE_URL`, `REDIS_URL`, `MEILISEARCH_HOST`, the MCP sidecar's
   `APP_URL`/`INTERNAL_APP_ORIGIN`, ...). These always win, so a `.env.local`
   cannot point a container at the host by mistake.

`app`, `documents-collab` and `mcp` declare both env files through `env_file:`
with `required: false`. The Open Mercato dev CLI additionally reads `.env`,
`.env.development`, `.env.local` and `.env.development.local` from the mounted
source and restarts the dev server when one of them changes.

Because no container publishes a host port, the app is reached over the
OrbStack container domain:

```text
http://app.<compose-project>.orb.local
```

The compose project defaults to the directory name, so every worktree gets its
own domain (`fondaco` -> `app.fondaco.orb.local`).

Two settings make that work:

- `APP_ALLOWED_ORIGINS` feeds `resolveAllowedDevOrigins()`
  (`src/lib/dev-origins.ts`) and therefore `allowedDevOrigins` in
  `next.config.ts`. `.env` ships `**.orb.local`, which matches every OrbStack
  domain and so needs no edit per worktree. Without it Next logs
  `Blocked cross-origin request to Next.js dev resource /_next/hmr` and HMR
  never connects.
- `APP_URL` is the browser-facing base URL used for links and origin
  allowlists. Set it per worktree in `.env.local`.

`next.config.ts` resolves `allowedDevOrigins` unconditionally. The dev server is
started by the Open Mercato CLI with `NODE_ENV=production`
(`buildServerProcessEnvironment`), so gating the allowlist on `NODE_ENV` left it
empty and blocked every non-localhost host. Next ignores `allowedDevOrigins`
outside the dev server, so resolving it always is inert in production.

## OpenAPI JSON import patch

Open Mercato CLI 0.8.0 generated an ESM OpenAPI bundle containing a native JSON
import without `with { type: "json" }`:

```text
TypeError [ERR_IMPORT_ATTRIBUTE_MISSING]:
Module "/app/node_modules/language-subtag-registry/data/json/registry.json"
needs an import attribute of "type: json"
```

The root cause was the CLI's esbuild resolver externalizing installed JSON
files. The generated ESM bundle was then executed directly by Node 24, which
requires an import attribute for external JSON modules.

The app applies a Yarn patch to `@open-mercato/cli@0.8.0`:

- `.yarn/patches/@open-mercato-cli-npm-0.8.0-352e8c707b.patch` lets esbuild
  bundle `.json` imports instead of externalizing them.
- `package.json` references the patch through Yarn's `patch:` protocol.
- `yarn.lock` pins the patched resolution.
- `Dockerfile` copies `.yarn/patches` before dependency installation in the
  builder, development, and runner stages.

No manual patch command is needed. `yarn install` and Docker builds apply it
automatically.

The Docker regression check is:

```sh
docker compose -f docker-compose.fullapp.dev.yml build app
docker run --rm --entrypoint sh fondaco-app -lc 'yarn generate'
```

Expected OpenAPI result:

```text
[OpenAPI] Bundle approach: 213 paths, 238 with requestBody schemas
[OpenAPI] Generated 213 API paths
```

There should be no `ERR_IMPORT_ATTRIBUTE_MISSING` message or static extraction
fallback.

When upgrading Open Mercato, check whether the CLI includes this fix upstream.
If it does, replace the patched dependency with the released version and remove
this patch. Keep the Dockerfile patch-copy step if any Yarn patches remain.

## MCP disabled in the development container

The app service sets:

```yaml
OM_DEV_WITH_MCP: 0
```

This prevents `yarn dev` from starting or provisioning its MCP child process.
It also removes the repeated `Module not found: "ai_assistant"` provisioning
retries. Set the value to `1` only when the MCP development stack is needed and
configured.

## Turbopack and Docker inotify limits

The app service also sets:

```yaml
OM_DEV_INOTIFY_CHECK: 0
```

Docker cannot change `fs.inotify.max_user_watches` through Compose because this
sysctl is host-wide rather than container-namespaced. Writing it from the
container fails because `/proc/sys` is read-only, and Docker rejects it through
the `sysctls` setting.

The Docker VM exposes about 1,048,576 watches, so the Compose-only preflight is
skipped and the existing limit is used. This restores Turbopack without adding
a privileged container.

Verify the active bundler:

```sh
docker compose -f docker-compose.fullapp.dev.yml exec -T app ps -ef
```

The process list should contain:

```text
next dev --turbopack
```

If Turbopack later reports a real `OS file watch limit reached` failure, remove
`OM_DEV_INOTIFY_CHECK: 0` and raise the inotify limit in the Docker host/VM. Do
not make the application container privileged just to suppress the preflight.
