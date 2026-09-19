import { InjectionPosition } from '@open-mercato/shared/modules/widgets/injection-position'
import type { InjectionRowActionWidget } from '@open-mercato/shared/modules/widgets/injection'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import fallbackMessages from '../../../i18n/en.json'

/**
 * "Print label" row action on the installed catalog product grid.
 *
 * Headless by design: `InjectionRowActionDefinition` has no component slot, so
 * mounting React here would buy nothing. The trade-off is that the callback has
 * no i18n context — `flash` renders whatever string it is given, and there is no
 * translator reachable outside React. So the API returns messages already
 * translated, and the module's own `en.json` is reused as the offline fallback
 * dictionary for the one case the server cannot answer: it is unreachable.
 * That keeps the wording in the translation file instead of inline literals.
 *
 * `onSelect` is synchronous and returns void, so the request is fired and its
 * outcome reported through `flash` rather than awaited by the table.
 */

type PrintLabelResponse = {
  ok?: boolean
  message?: string
  error?: string
}

/** English wording for the offline path only; the server translates otherwise. */
function fallbackText(key: keyof typeof fallbackMessages): string {
  return fallbackMessages[key]
}

function readProductId(row: unknown): string | null {
  if (!row || typeof row !== 'object') return null
  const value = (row as Record<string, unknown>).id
  return typeof value === 'string' && value.length > 0 ? value : null
}

async function printLabel(productId: string): Promise<void> {
  try {
    const { ok, result } = await apiCall<PrintLabelResponse>('/api/label_printing/print-label', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'catalog.product', id: productId }),
    })

    if (!ok) {
      // The route always answers with a translated `error`; the fallback only
      // covers a response that never reached the handler (e.g. a proxy page).
      flash(result?.error ?? fallbackText('label_printing.print.error.unexpected'), 'error')
      return
    }
    flash(result?.message ?? fallbackText('label_printing.print.success'), 'success')
  } catch {
    flash(fallbackText('label_printing.print.error.unexpected'), 'error')
  }
}

const widget: InjectionRowActionWidget = {
  metadata: {
    id: 'label_printing.injection.print-label-row-action',
    requiredModules: ['catalog'],
    features: ['label_printing.print'],
    priority: 40,
  },
  rowActions: [
    {
      id: 'label_printing.product.print',
      label: 'label_printing.action.print',
      placement: { position: InjectionPosition.After, relativeTo: 'view' },
      onSelect: (row) => {
        const productId = readProductId(row)
        if (!productId) return
        void printLabel(productId)
      },
    },
  ],
}

export default widget
