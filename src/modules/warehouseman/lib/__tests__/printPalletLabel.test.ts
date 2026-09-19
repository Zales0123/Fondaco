import { afterEach, describe, expect, it } from '@jest/globals'
import { printPalletLabel } from '../receivingApi'

type FetchType = typeof globalThis.fetch

/**
 * A wedged printer does not answer and does not fail.
 *
 * The serial write never calls back, so the route never reaches its own error
 * handling and never sends a response — the request simply stays open. Nothing
 * arrives for `try/catch` to catch, which is why the pallet screen sat on its
 * mutation forever rather than reporting a print failure.
 */
function neverAnswers(): FetchType {
  return ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject((init.signal as AbortSignal).reason)
      })
    })) as FetchType
}

describe('printPalletLabel', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('gives up instead of hanging when the printer never answers', async () => {
    globalThis.fetch = neverAnswers()

    await expect(printPalletLabel('7d1f4f8c-0000-4000-8000-000000000001', 30)).rejects.toMatchObject(
      { name: 'TimeoutError' },
    )
  })
})
