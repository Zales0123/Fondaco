import { z } from 'zod'

export const goodsReceiptStatusSchema = z.enum(['draft', 'confirmed'])

/**
 * A calendar day, the same shape the document itself is written in. An empty string is
 * accepted and dropped, because a cleared date field submits one and clearing a filter is
 * not an error.
 */
const calendarDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a calendar day as YYYY-MM-DD')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)), 'Not a real calendar day')

const optionalCalendarDay = z.union([calendarDay, z.literal('')]).optional()

export const goodsReceiptListSchema = z
  .object({
    id: z.string().uuid().optional(),
    ids: z.string().optional(),
    page: z.coerce.number().min(1).default(1),
    pageSize: z.coerce.number().min(1).max(100).default(50),
    sortField: z.string().optional(),
    sortDir: z.enum(['asc', 'desc']).optional(),
    status: z.union([goodsReceiptStatusSchema, z.literal('')]).optional(),
    warehouseId: z.union([z.string().uuid(), z.literal('')]).optional(),
    documentDateFrom: optionalCalendarDay,
    documentDateTo: optionalCalendarDay,
    /** Free text, matched against Document Number and Supplier. */
    search: z.string().optional(),
  })
  .passthrough()

export type GoodsReceiptListQuery = z.infer<typeof goodsReceiptListSchema>

export const goodsReceiptLineBodySchema = z.object({
  catalogProductId: z.string().uuid(),
  /**
   * A fractional quantity must be sent as a string — a JSON number cannot carry one
   * faithfully, and two different quantities would arrive as the same value. A whole count
   * may be sent as a number. A decimal comma is accepted, because a Polish keyboard
   * produces one.
   */
  quantity: z
    .union([z.string(), z.number().int().positive()])
    .describe('Decimal string (e.g. "2.5"), or a whole number. Must be greater than zero.'),
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
