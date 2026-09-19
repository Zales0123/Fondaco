import { describe, expect, it } from '@jest/globals'
import type { MutationGuardInput } from '@open-mercato/shared/lib/crud/mutation-guard-registry'
import { guards } from '../guards'

const [bulkCodeConfigGuard] = guards

function input(customFields: Record<string, unknown>, operation: MutationGuardInput['operation'] = 'update'): MutationGuardInput {
  return {
    tenantId: 'tenant-1',
    organizationId: 'org-1',
    userId: 'user-1',
    resourceKind: 'catalog.variant',
    resourceId: 'variant-1',
    operation,
    requestMethod: operation === 'create' ? 'POST' : 'PUT',
    requestHeaders: new Headers(),
    mutationPayload: { customFields },
  }
}

describe('bulkCodeConfigGuard', () => {
  it('rejects a bulk quantity set without a bulk barcode', async () => {
    const result = await bulkCodeConfigGuard.validate(input({ bulk_quantity: 24 }))
    expect(result.ok).toBe(false)
  })

  it('rejects a bulk quantity paired with a blank bulk barcode', async () => {
    const result = await bulkCodeConfigGuard.validate(input({ bulk_barcode: '   ', bulk_quantity: 24 }))
    expect(result.ok).toBe(false)
  })

  it('allows both fields set together', async () => {
    const result = await bulkCodeConfigGuard.validate(input({ bulk_barcode: '9999999999999', bulk_quantity: 24 }))
    expect(result.ok).toBe(true)
  })

  it('allows neither field set', async () => {
    const result = await bulkCodeConfigGuard.validate(input({}))
    expect(result.ok).toBe(true)
  })

  it('allows a bulk barcode set without a quantity (an incomplete pair the other way is not this rule)', async () => {
    const result = await bulkCodeConfigGuard.validate(input({ bulk_barcode: '9999999999999' }))
    expect(result.ok).toBe(true)
  })

  it('applies on create as well as update', async () => {
    const result = await bulkCodeConfigGuard.validate(input({ bulk_quantity: 24 }, 'create'))
    expect(result.ok).toBe(false)
  })
})
