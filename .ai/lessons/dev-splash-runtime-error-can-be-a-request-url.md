---
title: "A red dev splash can be a request URL, not a runtime error"
modules: ["platform"]
areas: ["debugging"]
topics: ["dev-runtime", "logging", "false-positive", "validation-gate"]
---

# A red dev splash can be a request URL, not a runtime error

**Context**: The splash reported `Runtime error detected` and offered `Restart runtime`,
with one detail line: `GET /api/pz/goods-receipts?status=confirmed&stockPostingStatus=failed
&pageSize=20&warehouseId=... 200 in 101ms`. The request had answered 200 and nothing in the
application had failed. `scripts/dev-runtime.mjs`'s `looksLikeFailure` matched `/\bfailed\b/i`
against the whole line, and the word was in the query string — the warehouseman receiving
panel polls that filter every 60 seconds, so the runtime latched red and stayed red.

**Problem**: The supervisor classifies child stdout by substring. A URL is the one part of a
log line the application does not author — it is whatever a browser asked for — so any path
or query value containing `failed`, `error` or `exception` can declare the runtime broken.
The detail shown is the offending line itself, which reads as though that request were the
error; the reflex is to go debugging the route, and the route is fine. `looksLikeFailure`
latches the compact reporter into raw passthrough, so the splash does not recover until the
process restarts.

**Rule**: A `Runtime error detected` whose detail is a request log line answering 2xx–4xx is
a classifier false positive, not a bug in the route it names. Check the detail's status code
before investigating the endpoint. When adding a substring failure pattern to the dev
supervisor, exclude structured lines whose severity is already encoded — that is what
`isNonRuntimeFailureLine` in `scripts/dev-runtime-log-policy.mjs` is for; a request log is
judged by its status there, never by its URL.

**Applies to**: `scripts/dev-runtime.mjs`, `scripts/dev-runtime-log-policy.mjs`,
`scripts/dev-runtime-state.mjs`, and any screen that puts a status word into a query
string — `src/modules/warehouseman/lib/receivingPanel.ts` is the one that surfaced it.
