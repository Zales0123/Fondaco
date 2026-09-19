// Flat ESLint config for a standalone Open Mercato app.
// `next lint` was removed in Next 16, so `yarn lint` runs the ESLint CLI
// against this config instead.
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'

const ignores = [
  'node_modules/**',
  '.next/**',
  '.mercato/**',
  '.ai/framework-context/**',
  // Playwright writes its HTML report and traces here; they are bundled vendor
  // assets, not source, and linting them buries real findings under hundreds of
  // errors from minified code.
  '.ai/qa/test-results/**',
  'dist/**',
  'out/**',
  'build/**',
  'next-env.d.ts',
]

const ruleOverrides = {
  'react/display-name': 'off',
  'react-hooks/immutability': 'off',
  'react-hooks/preserve-manual-memoization': 'off',
  'react-hooks/purity': 'off',
  'react-hooks/refs': 'off',
  'react-hooks/set-state-in-effect': 'off',
  'react-hooks/static-components': 'off',
}

export default [
  ...nextCoreWebVitals,
  { ignores },
  { name: 'app/rule-overrides', rules: ruleOverrides },
]
