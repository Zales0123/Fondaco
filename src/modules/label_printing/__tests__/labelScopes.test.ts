/**
 * Scope resolution is where a wrong answer becomes a label that scans as the
 * wrong product, so every refusal path is asserted explicitly.
 */
import { describe, expect, it } from '@jest/globals'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  isLabelScopeId,
  LABEL_SCOPE_IDS,
  LabelNotAvailableError,
  resolveLabelSubject,
} from '../lib/labelScopes'

type Row = {
  id: string
  sku: string | null
  barcode: string | null
  gtin_type: string | null
  is_default: boolean
}

/**
 * Stands in for the connection. The resolver orders by `is_default desc` in
 * SQL, so the fake returns rows already in that order — mirroring what the
 * database would hand back.
 */
function ctxWith(rows: Row[], onQuery?: (sql: string, params: unknown[]) => void) {
  const em = {
    getConnection: () => ({
      execute: async (sql: string, params: unknown[]) => {
        onQuery?.(sql, params)
        return rows
      },
    }),
  } as unknown as EntityManager
  return { em, tenantId: 'tenant-1', organizationId: 'org-1' }
}

const variant = (over: Partial<Row> = {}): Row => ({
  id: 'v1',
  sku: 'SKU-1',
  barcode: '2044281856787',
  gtin_type: 'ean13',
  is_default: true,
  ...over,
})

describe('label scope registry', () => {
  it('exposes catalog.product', () => {
    expect(LABEL_SCOPE_IDS).toContain('catalog.product')
    expect(isLabelScopeId('catalog.product')).toBe(true)
    expect(isLabelScopeId('nope')).toBe(false)
  })

  it('exposes pz.pallet', () => {
    expect(LABEL_SCOPE_IDS).toContain('pz.pallet')
    expect(isLabelScopeId('pz.pallet')).toBe(true)
  })
})

describe('catalog.product resolver', () => {
  it('constrains the lookup to the session tenant and organization', async () => {
    let seen: unknown[] = []
    await resolveLabelSubject('catalog.product', 'prod-1', ctxWith([variant()], (_sql, params) => {
      seen = params
    }))
    // A caller-supplied product id must never widen the scope.
    expect(seen).toEqual(['prod-1', 'tenant-1', 'org-1'])
  })

  it('uses the default variant GTIN', async () => {
    const subject = await resolveLabelSubject('catalog.product', 'prod-1', ctxWith([
      variant({ id: 'v-default', sku: 'DEFAULT', is_default: true }),
      variant({ id: 'v-other', sku: 'OTHER', is_default: false, barcode: '2053301404433' }),
    ]))
    expect(subject).toEqual({
      symbology: 'ean13',
      value: '2044281856787',
      describe: 'variant DEFAULT',
    })
  })

  it('uses the only variant when none is marked default', async () => {
    const subject = await resolveLabelSubject('catalog.product', 'prod-1', ctxWith([
      variant({ is_default: false }),
    ]))
    expect(subject.value).toBe('2044281856787')
  })

  it.each([
    ['ean8', '96385074', 'ean8'],
    ['upc', '012345678905', 'upca'],
  ])('maps gtin type %s to its symbology', async (gtin, value, symbology) => {
    const subject = await resolveLabelSubject('catalog.product', 'prod-1', ctxWith([
      variant({ gtin_type: gtin, barcode: value }),
    ]))
    expect(subject.symbology).toBe(symbology)
  })

  it('refuses a product with no active variant', async () => {
    await expect(
      resolveLabelSubject('catalog.product', 'prod-1', ctxWith([])),
    ).rejects.toMatchObject({ messageKey: 'label_printing.print.error.noVariant' })
  })

  it('refuses rather than guessing between variants with no default', async () => {
    await expect(
      resolveLabelSubject('catalog.product', 'prod-1', ctxWith([
        variant({ id: 'a', sku: 'A', is_default: false }),
        variant({ id: 'b', sku: 'B', is_default: false }),
      ])),
    ).rejects.toMatchObject({ messageKey: 'label_printing.print.error.ambiguousVariant' })
  })

  it.each([null, '', '   '])('refuses when the barcode is %p', async (barcode) => {
    await expect(
      resolveLabelSubject('catalog.product', 'prod-1', ctxWith([variant({ barcode })])),
    ).rejects.toMatchObject({ messageKey: 'label_printing.print.error.noBarcode' })
  })

  it.each(['mpn', 'asin', 'isbn', null])(
    'refuses gtin type %p, which is not a printable barcode standard',
    async (gtin) => {
      await expect(
        resolveLabelSubject('catalog.product', 'prod-1', ctxWith([variant({ gtin_type: gtin })])),
      ).rejects.toMatchObject({ messageKey: 'label_printing.print.error.unsupportedGtin' })
    },
  )

  it('refusals are LabelNotAvailableError, not faults', async () => {
    await expect(
      resolveLabelSubject('catalog.product', 'prod-1', ctxWith([variant({ barcode: null })])),
    ).rejects.toBeInstanceOf(LabelNotAvailableError)
  })
})

type PalletRow = {
  id: string
  code: string | null
  tenant_id: string
  organization_id: string
}

/**
 * A stored-row fake rather than a canned result set: tenant and organization
 * isolation is the thing under test for this scope, so the fake applies the
 * same filter the SQL does instead of trusting the resolver to have asked for
 * it. A resolver that dropped either scope column would still return rows here
 * and the isolation tests would fail — which is the point.
 */
function palletCtxWith(rows: PalletRow[], onQuery?: (sql: string, params: unknown[]) => void) {
  const em = {
    getConnection: () => ({
      execute: async (sql: string, params: unknown[]) => {
        onQuery?.(sql, params)
        const [id, tenantId, organizationId] = params as string[]
        return rows
          .filter((row) => row.id === id
            && row.tenant_id === tenantId
            && row.organization_id === organizationId)
          .map((row) => ({ id: row.id, code: row.code }))
      },
    }),
  } as unknown as EntityManager
  return { em, tenantId: 'tenant-1', organizationId: 'org-1' }
}

const pallet = (over: Partial<PalletRow> = {}): PalletRow => ({
  id: 'pallet-1',
  code: 'PAL-000123',
  tenant_id: 'tenant-1',
  organization_id: 'org-1',
  ...over,
})

describe('pz.pallet resolver', () => {
  it('constrains the lookup to the session tenant and organization', async () => {
    let seenSql = ''
    let seen: unknown[] = []
    await resolveLabelSubject('pz.pallet', 'pallet-1', palletCtxWith([pallet()], (sql, params) => {
      seenSql = sql
      seen = params
    }))
    // A caller-supplied pallet id must never widen the scope.
    expect(seen).toEqual(['pallet-1', 'tenant-1', 'org-1'])
    expect(seenSql).toContain('tenant_id = ?')
    expect(seenSql).toContain('organization_id = ?')
  })

  it('prints the pallet code as code128', async () => {
    const subject = await resolveLabelSubject('pz.pallet', 'pallet-1', palletCtxWith([
      pallet({ code: 'PAL-000123' }),
    ]))
    expect(subject).toEqual({
      symbology: 'code128',
      value: 'PAL-000123',
      describe: 'pallet PAL-000123',
    })
  })

  it('refuses a pallet belonging to another organization', async () => {
    await expect(
      resolveLabelSubject('pz.pallet', 'pallet-1', palletCtxWith([
        pallet({ organization_id: 'org-2' }),
      ])),
    ).rejects.toMatchObject({ messageKey: 'label_printing.print.error.noPallet' })
  })

  it('refuses a pallet belonging to another tenant', async () => {
    await expect(
      resolveLabelSubject('pz.pallet', 'pallet-1', palletCtxWith([
        pallet({ tenant_id: 'tenant-2' }),
      ])),
    ).rejects.toMatchObject({ messageKey: 'label_printing.print.error.noPallet' })
  })

  it('refuses an unknown pallet id', async () => {
    await expect(
      resolveLabelSubject('pz.pallet', 'pallet-missing', palletCtxWith([pallet()])),
    ).rejects.toMatchObject({ messageKey: 'label_printing.print.error.noPallet' })
  })

  it.each([null, '', '   '])('refuses a pallet whose code is %p', async (code) => {
    await expect(
      resolveLabelSubject('pz.pallet', 'pallet-1', palletCtxWith([pallet({ code })])),
    ).rejects.toMatchObject({ messageKey: 'label_printing.print.error.noPalletCode' })
  })

  it('refusals are LabelNotAvailableError, not faults', async () => {
    await expect(
      resolveLabelSubject('pz.pallet', 'pallet-1', palletCtxWith([])),
    ).rejects.toBeInstanceOf(LabelNotAvailableError)
  })
})
