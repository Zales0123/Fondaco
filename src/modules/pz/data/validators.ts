import { z } from 'zod'

export const goodsReceiptStatusSchema = z.enum(['draft', 'confirmed'])

export const goodsReceiptListSchema = z
  .object({
    id: z.string().uuid().optional(),
    ids: z.string().optional(),
    page: z.coerce.number().min(1).default(1),
    pageSize: z.coerce.number().min(1).max(100).default(50),
    sortField: z.string().optional(),
    sortDir: z.enum(['asc', 'desc']).optional(),
  })
  .passthrough()

export type GoodsReceiptListQuery = z.infer<typeof goodsReceiptListSchema>

export const goodsReceiptLineBodySchema = z.object({
  catalogProductId: z.string().uuid(),
  /** A decimal string or number; a decimal comma is accepted because a Polish keyboard produces one. */
  quantity: z.union([z.string(), z.number()]),
  unit: z.string().max(50).nullable().optional(),
})

/**
 * Documents the write body for OpenAPI. It is deliberately NOT the runtime authority:
 * `parseGoodsReceiptWriteInput` validates the request so every refusal can name the field
 * that caused it and speak the caller's language, which a schema rejection cannot.
 */
export const goodsReceiptWriteBodySchema = z.object({
  documentNumber: z.string().min(1).max(100),
  documentDate: z.string().describe('Calendar day, YYYY-MM-DD. Must not be in the future.'),
  supplierName: z.string().min(1).max(200),
  warehouseId: z.string().uuid(),
  lines: z.array(goodsReceiptLineBodySchema).min(1),
})
