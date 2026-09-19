/** @type {import('jest').Config} */
// The `scripts/` dev-tooling suite, which `jest.config.cjs` cannot host.
//
// Those scripts ship as native ESM, and a `.mjs` file cannot be down-compiled to
// CommonJS — TypeScript emits ESM for that extension whatever `module` says — so
// their tests have to run through Jest's ESM loader. Enabling it costs a
// process-wide `NODE_OPTIONS=--experimental-vm-modules`, which changes how the
// app's own suite resolves `@open-mercato/*` and breaks it. Hence a second,
// isolated run rather than a second project inside the first config.
module.exports = {
  testEnvironment: 'node',
  passWithNoTests: true,
  rootDir: '.',
  roots: ['<rootDir>/scripts'],
  moduleFileExtensions: ['mjs', 'js', 'json'],
  testMatch: ['**/__tests__/**/*.test.mjs'],
  // No transform: the files under test are loaded as the ESM they already are.
  transform: {},
}
