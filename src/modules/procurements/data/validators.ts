import { z } from 'zod'

export const purchaseOrderStatusSchema = z.enum(['draft', 'released', 'cancelled'])

/**
 * A calendar day, the same shape the document itself is written in. An empty string is
 * accepted and dropped, because a cleared date field submits one and clearing a filter is not
 * an error.
 */
const calendarDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a calendar day as YYYY-MM-DD')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)), 'Not a real calendar day')

const optionalCalendarDay = z.union([calendarDay, z.literal('')]).optional()

export const purchaseOrderListSchema = z
  .object({
    id: z.string().uuid().optional(),
    ids: z.string().optional(),
    page: z.coerce.number().min(1).default(1),
    pageSize: z.coerce.number().min(1).max(100).default(50),
    sortField: z.string().optional(),
    sortDir: z.enum(['asc', 'desc']).optional(),
    status: z.union([purchaseOrderStatusSchema, z.literal('')]).optional(),
    warehouseId: z.union([z.string().uuid(), z.literal('')]).optional(),
    orderDateFrom: optionalCalendarDay,
    orderDateTo: optionalCalendarDay,
    expectedDateFrom: optionalCalendarDay,
    expectedDateTo: optionalCalendarDay,
    /** Free text, matched against Document Number and Supplier. */
    search: z.string().optional(),
  })
  .passthrough()

export type PurchaseOrderListQuery = z.infer<typeof purchaseOrderListSchema>

/**
 * The cross-order line view. Its status, supplier and warehouse filters are header facts: the
 * route resolves them to a set of order ids first, because a line carries no copy of them.
 */
export const purchaseOrderLineListSchema = z
  .object({
    id: z.string().uuid().optional(),
    ids: z.string().optional(),
    page: z.coerce.number().min(1).default(1),
    pageSize: z.coerce.number().min(1).max(100).default(50),
    sortField: z.string().optional(),
    sortDir: z.enum(['asc', 'desc']).optional(),
    purchaseOrderId: z.union([z.string().uuid(), z.literal('')]).optional(),
    status: z.union([purchaseOrderStatusSchema, z.literal('')]).optional(),
    warehouseId: z.union([z.string().uuid(), z.literal('')]).optional(),
    expectedDateFrom: optionalCalendarDay,
    expectedDateTo: optionalCalendarDay,
    /** Free text, matched against the line's product snapshot and its order's number/supplier. */
    search: z.string().optional(),
  })
  .passthrough()

export type PurchaseOrderLineListQuery = z.infer<typeof purchaseOrderLineListSchema>

export const purchaseOrderLineBodySchema = z.object({
  catalogProductId: z.string().uuid(),
  /**
   * A fractional value must be sent as a string — a JSON number cannot carry one faithfully,
   * and two different quantities would arrive as the same value. A whole count may be sent as
   * a number. A decimal comma is accepted, because a Polish keyboard produces one.
   */
  quantityOrdered: z
    .union([z.string(), z.number().int().positive()])
    .describe('Decimal string (e.g. "2.5"), or a whole number. Must be greater than zero.'),
  unit: z.string().max(50).nullable().optional(),
  unitPriceNet: z
    .union([z.string(), z.number().int().nonnegative()])
    .describe('Net price per unit as a decimal string (e.g. "12.3450"), or a whole number. Zero is allowed.'),
  expectedDate: z
    .union([calendarDay, z.literal(''), z.null()])
    .optional()
    .describe('Calendar day, YYYY-MM-DD. Empty or null follows the order header.'),
})

/**
 * Documents the write body for OpenAPI. It is deliberately NOT the runtime authority:
 * `parsePurchaseOrderWriteInput` validates the request so every refusal can name the field
 * that caused it and speak the caller's language, which a schema rejection cannot.
 */
export const purchaseOrderWriteBodySchema = z.object({
  documentNumber: z.string().min(1).max(100),
  orderDate: z.string().describe('Calendar day, YYYY-MM-DD.'),
  expectedDate: z
    .union([calendarDay, z.literal(''), z.null()])
    .optional()
    .describe('Calendar day, YYYY-MM-DD. Must not be earlier than the order date.'),
  supplierName: z.string().min(1).max(200),
  warehouseId: z.string().uuid(),
  currencyCode: z.string().length(3).describe('ISO-4217 code, for example PLN.'),
  notes: z.string().max(2000).nullable().optional(),
  lines: z.array(purchaseOrderLineBodySchema).min(1),
})
