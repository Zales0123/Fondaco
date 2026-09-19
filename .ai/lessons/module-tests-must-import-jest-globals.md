---
title: "A module test under src/ must import its jest globals, or yarn build fails"
modules: ["platform"]
areas: ["testing"]
topics: ["validation-gate", "typescript", "app-modules"]
---

# A module test under src/ must import its jest globals, or yarn build fails

**Context**: A new `src/modules/procurements/lib/__tests__/*.test.ts` used bare `describe`,
`it` and `expect`. `yarn test` passed (18 suites, 216 tests) and `yarn typecheck` passed with
exit 0. `yarn build` then failed the TypeScript step with dozens of `TS2593: Cannot find name
'describe'` / `TS2304: Cannot find name 'expect'` in exactly those files.

**Problem**: Two different type checks run over the same tree with different `types`
resolution. `yarn typecheck` (`tsc --noEmit` on the repo `tsconfig.json`, whose `typeRoots`
include `node_modules/@types`) sees the jest globals; the TypeScript pass Next.js runs inside
`next build` does not, and `src/modules/**` is part of the app tree it checks. So a bare-global
test file is invisible to the two fastest gates and only surfaces in the slowest one, after a
full compile.

**Rule**: Start every test file under `src/modules/**` with
`import { describe, expect, it } from '@jest/globals'` (add `beforeEach`, `jest`, etc. as
needed). The existing `pz` tests already do this; copy that first line along with the rest of
the pattern. Running `yarn test` and `yarn typecheck` green is not evidence the build will
pass.

**Applies to**: `src/modules/<id>/**/__tests__/*.test.ts` in this standalone app; recorded
while adding `procurements`.
