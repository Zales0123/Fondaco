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
