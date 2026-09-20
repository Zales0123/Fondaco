import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { OpenApiMethodDoc, OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { LABEL_PRINTER_SERVICE } from '../../di'
import type { LabelPrinterService } from '../../lib/labelPrinterService'
import { renderBarcodeLabel } from '../../lib/barcodeImage'
import { readLabelGeometry } from '../../lib/labelGeometry'
import {
  LABEL_SCOPE_IDS,
  resolveLabelSubject,
  type LabelScopeId,
} from '../../lib/labelScopes'

const logger = createLogger('label_printing').child({ component: 'print-label-route' })

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['label_printing.print'] },
}

const requestSchema = z.object({
  scope: z.enum(LABEL_SCOPE_IDS as [LabelScopeId, ...LabelScopeId[]]),
  id: z.string().uuid(),
})

/**
 * Messages are translated here rather than in the widget: a DataTable row
 * action is a headless declaration with no React context, so it cannot reach
 * `useT()`. The server owns the wording; the client only displays it.
 *
 * Keyed on the error's own `name`/`code` strings, never `instanceof`. The
 * printer service arrives through the DI container, which loads it from a
 * different module instance than the one this route imports from, so the two
 * copies of each error class are not the same object and every `instanceof`
 * answered `false` — a real `printer-timeout` reached the operator as the
 * generic 500 "The label could not be printed." instead of the 502 it is.
 * Each class assigns `this.name` and a literal `code`, and plain strings cross
 * that boundary intact (and survive minification, which `constructor.name`
 * would not).
 */
function describeFailure(error: unknown): {
  status: number
  code: string
  key: string
  fallback: string
} {
  const failure = (error ?? {}) as { name?: unknown; code?: unknown; messageKey?: unknown }
  const name = typeof failure.name === 'string' ? failure.name : ''
  const code = typeof failure.code === 'string' ? failure.code : ''

  // A refusal, not a fault: the record simply has nothing printable. The
  // wording is the scope's own, so it is only recognised with its key.
  if (name === 'LabelNotAvailableError' && typeof failure.messageKey === 'string') {
    return {
      status: 422,
      code: code || 'label-not-available',
      key: failure.messageKey,
      fallback: 'There is no barcode to print for this record.',
    }
  }
  if (name === 'PrinterBusyError') {
    return {
      status: 409,
      code: code || 'printer-busy',
      key: 'label_printing.print.error.busy',
      fallback: 'The label printer is already printing. Try again in a moment.',
    }
  }
  // `printer-unreachable` is raised by the print job itself, once the printer
  // has failed to answer any setup command. It means the same thing to the
  // operator as a port that would not open, so it gets the same answer.
  if (name === 'PrinterUnavailableError' || code === 'printer-unreachable') {
    return {
      status: 503,
      code: code || 'printer-unavailable',
      key: 'label_printing.print.error.unavailable',
      fallback: 'The label printer is not reachable. Check that it is switched on and paired.',
    }
  }
  if (name === 'BarcodeRenderError') {
    return {
      status: 500,
      code: code || 'barcode-render-failed',
      key: 'label_printing.print.error.render',
      fallback: 'The barcode could not be rendered onto the label.',
    }
  }
  if (name === 'RasterizeError') {
    return {
      status: 500,
      code: 'invalid-label-image',
      key: 'label_printing.print.error.image',
      fallback: 'The label image could not be prepared for printing.',
    }
  }
  if (name === 'PrinterError') {
    return {
      status: 502,
      code: code || 'printer-error',
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
    const em = container.resolve<EntityManager>('em')

    // Scope comes from the session, never the payload: the record id is
    // caller-supplied, so the lookup is constrained to the caller's own tenant
    // and organization and a foreign id simply resolves to nothing.
    const subject = await resolveLabelSubject(parsed.data.scope, parsed.data.id, {
      em,
      tenantId: auth.tenantId,
      organizationId: auth.orgId,
    })

    const image = await renderBarcodeLabel({
      symbology: subject.symbology,
      value: subject.value,
      geometry: readLabelGeometry(),
    })

    const printer = container.resolve<LabelPrinterService>(LABEL_PRINTER_SERVICE)
    await printer.printImage(image)

    logger.info('Printed label', {
      scope: parsed.data.scope,
      id: parsed.data.id,
      subject: subject.describe,
      symbology: subject.symbology,
      tenantId: auth.tenantId,
      organizationId: auth.orgId,
    })
    return Response.json({
      ok: true,
      message: translate('label_printing.print.success', 'Label sent to the printer.'),
    })
  } catch (error) {
    const failure = describeFailure(error)
    const logPayload = { err: error, scope: parsed.data.scope, id: parsed.data.id }
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
  summary: 'Print a barcode label on the NiimBot B1',
  description:
    'Resolves the record into a barcode value and symbology, renders it onto the configured '
    + 'label geometry and sends it to the serial label printer. For `catalog.product` the value '
    + "is the default variant's GTIN; for `pz.pallet` it is the pallet's own code as Code128. "
    + 'A record with nothing printable — a variant without a barcode, a pallet that does not '
    + "exist in the caller's tenant and organization — is refused with 422 rather than printed "
    + 'blank. The printer is an exclusive resource, so a concurrent request is rejected with 409 '
    + 'rather than queued. A printer that is paired but not connected is reported as unreachable '
    + 'once it fails to answer the setup commands, rather than after the whole job times out.',
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
    { status: 422, description: 'The record has no printable barcode', schema: errorSchema },
    { status: 502, description: 'The printer reported an error or never finished', schema: errorSchema },
    { status: 503, description: 'No printer configured, the serial port could not be opened, or the printer never answered', schema: errorSchema },
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
