import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  isNonFailingRequestLogLine,
  isNonRuntimeFailureLine,
} from '../dev-runtime-log-policy.mjs'

/**
 * The supervisor's own failure test, reproduced here because it lives in
 * `dev-runtime.mjs` next to the process spawning and cannot be imported.
 * Only the exclusion set it consults is under test.
 */
function looksLikeFailure(line) {
  if (isNonRuntimeFailureLine(line)) return false
  return /^error\b/i.test(line)
    || /^Error:/i.test(line)
    || /^⨯\s/.test(line)
    || /\bfailed\b/i.test(line)
    || /\bexception\b/i.test(line)
}

const SUCCESSFUL_FAILED_FILTER_REQUEST =
  'GET /api/pz/goods-receipts?status=confirmed&stockPostingStatus=failed&pageSize=20'
  + '&warehouseId=8a4967c9-993e-4e2f-a09e-b188eaef89fc 200 in 101ms'
  + ' (next.js: 19ms, application-code: 82ms)'

describe('isNonFailingRequestLogLine', () => {
  it('excludes the warehouseman panel poll that asks for failed stock postings', () => {
    expect(isNonFailingRequestLogLine(SUCCESSFUL_FAILED_FILTER_REQUEST)).toBe(true)
    expect(looksLikeFailure(SUCCESSFUL_FAILED_FILTER_REQUEST)).toBe(false)
  })

  it('excludes a served request however alarming its url reads', () => {
    const lines = [
      'GET /api/pz/goods-receipts?search=exception 200 in 12ms',
      'POST /api/orders?mode=failed 201 in 44ms',
      'GET /backend/imports/failed 304 in 3ms',
      'DELETE /api/jobs/failed-uploads 404 in 7ms (next.js: 2ms, application-code: 5ms)',
    ]
    for (const line of lines) {
      expect(isNonFailingRequestLogLine(line)).toBe(true)
      expect(looksLikeFailure(line)).toBe(false)
    }
  })

  it('accepts the duration formats the dev logger prints', () => {
    expect(isNonFailingRequestLogLine('GET /slow?q=failed 200 in 2.1s')).toBe(true)
    expect(isNonFailingRequestLogLine('GET /slower?q=failed 200 in 3m')).toBe(true)
  })

  it('keeps a server error a failure — the status is what decides, not the url', () => {
    const line = 'GET /api/pz/goods-receipts?status=confirmed 500 in 31ms'
    expect(isNonFailingRequestLogLine(line)).toBe(false)
    expect(isNonRuntimeFailureLine(line)).toBe(false)
  })

  it('leaves everything that is not a request log alone', () => {
    const failures = [
      'Error: connection terminated unexpectedly',
      '⨯ Internal Server Error',
      '[pz] posting stock failed for ZPZ/1/2026',
      'GET /api/pz/goods-receipts failed',
    ]
    for (const line of failures) {
      expect(isNonFailingRequestLogLine(line)).toBe(false)
      expect(looksLikeFailure(line)).toBe(true)
    }
  })
})

/**
 * `looksLikeFailure` only stays honest while it asks the exclusion set first. It lives
 * beside the process spawning in `dev-runtime.mjs` and cannot be imported, so the
 * delegation is asserted against the source — without it the copy above proves nothing
 * about the supervisor that actually runs.
 */
describe('the supervisor still delegates to this policy', () => {
  it('consults the exclusion set before matching failure words', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../dev-runtime.mjs', import.meta.url)),
      'utf8',
    )
    const body = /function looksLikeFailure\(line\) \{([\s\S]*?)\n\}/.exec(source)?.[1]
    expect(body).toBeTruthy()
    expect(body).toContain('isNonRuntimeFailureLine(line)) return false')
    // The word match this guards against must still be the thing that comes after it.
    expect(body.indexOf('isNonRuntimeFailureLine')).toBeLessThan(body.indexOf('\\bfailed\\b'))
  })
})
