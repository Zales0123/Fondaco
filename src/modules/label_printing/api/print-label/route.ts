import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { OpenApiMethodDoc, OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { LABEL_PRINTER_SERVICE } from '../../di'
import {
  PrinterUnavailableError,
  type LabelPrinterService,
} from '../../lib/labelPrinterService'
import { PrinterBusyError } from '../../lib/printQueue'
import { PrinterError } from '../../lib/niimbotPrinter'
import { RasterizeError } from '../../lib/rasterize'

const logger = createLogger('label_printing').child({ component: 'print-label-route' })

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['label_printing.print'] },
}

/**
 * First iteration prints one fixed label for every product.
 *
 * `productId` is accepted, validated and logged but does not yet change the
 * output — it is here so the client contract does not have to change when real
 * per-product barcode rendering replaces the fixed asset.
 */
const LABEL_ASSET_PATH = path.join(process.cwd(), 'src/modules/label_printing/assets/barcode.gif')

const requestSchema = z.object({
  productId: z.string().min(1).max(200),
})

/**
 * Messages are translated here rather than in the widget: a DataTable row
 * action is a headless declaration with no React context, so it cannot reach
 * `useT()`. The server owns the wording; the client only displays it.
 */
function describeFailure(error: unknown): {
  status: number
  code: string
  key: string
  fallback: string
} {
  if (error instanceof PrinterBusyError) {
    return {
      status: 409,
      code: error.code,
      key: 'label_printing.print.error.busy',
      fallback: 'The label printer is already printing. Try again in a moment.',
    }
  }
  if (error instanceof PrinterUnavailableError) {
    return {
      status: 503,
      code: error.code,
      key: 'label_printing.print.error.unavailable',
      fallback: 'The label printer is not reachable. Check that it is switched on and paired.',
    }
  }
  if (error instanceof RasterizeError) {
    return {
      status: 500,
      code: 'invalid-label-image',
      key: 'label_printing.print.error.image',
      fallback: 'The label image could not be prepared for printing.',
    }
  }
  if (error instanceof PrinterError) {
    return {
      status: 502,
      code: error.code,
      key: 'label_printing.print.error.printer',
      fallback: 'The printer reported a problem and did not finish the label.',
    }
  }
  return {
    status: 500,
    code: 'internal-error',
    key: 'label_printing.print.error.unexpected',
    fallback: 'The label could not be printed.',
  }
}

export async function POST(request: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  if (!auth.orgId) return Response.json({ error: 'Organization scope required' }, { status: 400 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { translate } = await resolveTranslations()

  try {
    const container = await createRequestContainer()
    const printer = container.resolve<LabelPrinterService>(LABEL_PRINTER_SERVICE)

    const image = await readFile(LABEL_ASSET_PATH)
    await printer.printImage(image)

    logger.info('Printed label', {
      productId: parsed.data.productId,
      tenantId: auth.tenantId,
      organizationId: auth.orgId,
    })
    return Response.json({
      ok: true,
      message: translate('label_printing.print.success', 'Label sent to the printer.'),
    })
  } catch (error) {
    const failure = describeFailure(error)
    const logPayload = { err: error, productId: parsed.data.productId }
    if (failure.status >= 500) logger.error('Label print failed', logPayload)
    else logger.warn('Label print rejected', logPayload)

    return Response.json(
      { error: translate(failure.key, failure.fallback), code: failure.code },
      { status: failure.status },
    )
  }
}

const labelPrintingTag = 'LabelPrinting'
const errorSchema = z.object({ error: z.string(), code: z.string().optional() })

const printLabelDoc: OpenApiMethodDoc = {
  summary: 'Print a product label on the NiimBot B1',
  description:
    'Sends the configured label image to the serial label printer and waits for the printer to report the job finished. The printer is an exclusive resource, so a concurrent request is rejected with 409 rather than queued. In this first iteration the printed image is a fixed asset and `productId` only identifies the request in the logs.',
  tags: [labelPrintingTag],
  responses: [
    {
      status: 200,
      description: 'The label was printed and the printer reported the job finished.',
      schema: z.object({ ok: z.literal(true), message: z.string() }),
    },
  ],
  errors: [
    { status: 400, description: 'Invalid body or missing organization scope', schema: errorSchema },
    { status: 401, description: 'Authentication required', schema: errorSchema },
    { status: 409, description: 'The printer is already printing', schema: errorSchema },
    { status: 502, description: 'The printer reported an error or never finished', schema: errorSchema },
    { status: 503, description: 'No printer configured or the serial port could not be opened', schema: errorSchema },
    { status: 500, description: 'Unexpected server error', schema: errorSchema },
  ],
}

export const openApi: OpenApiRouteDoc = {
  tag: labelPrintingTag,
  summary: 'Label printing',
  methods: {
    POST: printLabelDoc,
  },
}
