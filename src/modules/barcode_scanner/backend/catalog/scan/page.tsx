"use client"

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { ScanLine } from 'lucide-react'
import { Page, PageHeader, PageBody } from '@open-mercato/ui/backend/Page'
import { Alert, AlertDescription, AlertTitle } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@open-mercato/ui/primitives/card'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { BarcodeScannerDialog } from '../../../components/BarcodeScannerDialog'

type VariantListItem = {
  id: string
  product_id?: string | null
  name?: string | null
  sku?: string | null
  barcode?: string | null
  is_active?: boolean | null
}

// The installed `/api/catalog/variants` GET is a `makeCrudRoute` paged list, so
// its rows live under `items` (see `createPagedListResponseSchema`).
type VariantListResponse = {
  items?: VariantListItem[] | null
  total?: number | null
}

type LookupState =
  | { kind: 'idle' }
  | { kind: 'searching'; code: string }
  | { kind: 'navigating'; code: string }
  | { kind: 'multiple'; code: string; candidates: VariantListItem[] }
  | { kind: 'empty'; code: string }
  | { kind: 'error'; code: string; message: string }

const EMPTY_VALUE = '—'
const LOOKUP_PAGE_SIZE = 25

function normalize(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/**
 * Resolution order: a single exact barcode hit, then a single exact SKU hit,
 * then a single result overall. Anything else is ambiguous and goes to the
 * chooser.
 */
function resolveMatch(items: VariantListItem[], code: string): VariantListItem | null {
  const target = normalize(code)
  if (!target) return null
  const byBarcode = items.filter((item) => normalize(item.barcode) === target && normalize(item.barcode) !== '')
  if (byBarcode.length === 1) return byBarcode[0]
  const bySku = items.filter((item) => normalize(item.sku) === target && normalize(item.sku) !== '')
  if (bySku.length === 1) return bySku[0]
  if (items.length === 1) return items[0]
  return null
}

export default function BarcodeScanPage() {
  const t = useT()
  const router = useRouter()
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [state, setState] = React.useState<LookupState>({ kind: 'idle' })
  const inFlightRef = React.useRef(false)

  const variantHref = React.useCallback(
    (productId: string, variantId: string) => `/backend/catalog/products/${productId}/variants/${variantId}`,
    [],
  )

  const openScanner = React.useCallback(() => {
    setState({ kind: 'idle' })
    setDialogOpen(true)
  }, [])

  const closeScanner = React.useCallback(() => {
    setDialogOpen(false)
  }, [])

  const openVariant = React.useCallback(
    (variant: VariantListItem, code: string) => {
      const productId = typeof variant.product_id === 'string' ? variant.product_id.trim() : ''
      if (!productId) {
        setState({
          kind: 'error',
          code,
          message: t(
            'barcodeScanner.error.missingProduct',
            'This variant is not linked to a product, so it cannot be opened.',
          ),
        })
        return
      }
      setState({ kind: 'navigating', code })
      setDialogOpen(false)
      router.push(variantHref(productId, variant.id))
    },
    [router, t, variantHref],
  )

  const handleDetected = React.useCallback(
    (code: string) => {
      const trimmed = code.trim()
      if (!trimmed || inFlightRef.current) return
      inFlightRef.current = true
      setState({ kind: 'searching', code: trimmed })
      const lookupError = t(
        'barcodeScanner.error.lookup',
        'Could not look up the scanned code. Check your connection and try again.',
      )
      void (async () => {
        try {
          const response = await readApiResultOrThrow<VariantListResponse>(
            `/api/catalog/variants?search=${encodeURIComponent(trimmed)}&pageSize=${LOOKUP_PAGE_SIZE}`,
            undefined,
            { errorMessage: lookupError },
          )
          const items = Array.isArray(response.items) ? response.items : []
          const match = resolveMatch(items, trimmed)
          if (match) {
            openVariant(match, trimmed)
            return
          }
          if (items.length > 1) {
            setState({ kind: 'multiple', code: trimmed, candidates: items })
            setDialogOpen(false)
            return
          }
          setState({ kind: 'empty', code: trimmed })
          setDialogOpen(false)
        } catch (err) {
          const message = err instanceof Error && err.message ? err.message : lookupError
          // Keep the dialog open so the user can simply rescan.
          setState({ kind: 'error', code: trimmed, message })
        } finally {
          inFlightRef.current = false
        }
      })()
    },
    [openVariant, t],
  )

  const busy = state.kind === 'searching' || state.kind === 'navigating'
  const statusMessage =
    state.kind === 'searching'
      ? t('barcodeScanner.status.searching', 'Looking up {code}…', { code: state.code })
      : state.kind === 'navigating'
        ? t('barcodeScanner.status.redirecting', 'Match found — opening the variant…')
        : null
  const errorMessage = state.kind === 'error' ? state.message : null

  const scanButtonLabel = t('barcodeScanner.action.scan', 'Scan barcode')
  const scanAgainLabel = t('barcodeScanner.action.scanAgain', 'Scan again')

  return (
    <Page>
      <PageHeader
        title={t('barcodeScanner.page.title', 'Scan barcode')}
        description={t(
          'barcodeScanner.page.description',
          'Scan a product barcode with your camera and jump straight to the matching variant.',
        )}
        actions={
          <Button type="button" size="lg" onClick={openScanner} disabled={busy}>
            <ScanLine aria-hidden="true" />
            <span>{scanButtonLabel}</span>
          </Button>
        }
      />
      <PageBody>
        {state.kind === 'idle' ? (
          <Card>
            <CardHeader>
              <CardTitle>{t('barcodeScanner.idle.title', 'Ready to scan')}</CardTitle>
              <CardDescription>
                {t(
                  'barcodeScanner.idle.description',
                  'Press “Scan barcode” to open the camera. A single matching variant opens automatically.',
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button type="button" onClick={openScanner}>
                <ScanLine aria-hidden="true" />
                <span>{scanButtonLabel}</span>
              </Button>
            </CardContent>
          </Card>
        ) : null}

        {busy && statusMessage ? (
          <Card>
            <CardContent className="flex items-center gap-3">
              <Spinner size="sm" />
              <p className="text-sm text-muted-foreground" aria-live="polite">
                {statusMessage}
              </p>
            </CardContent>
          </Card>
        ) : null}

        {state.kind === 'error' ? (
          <Alert status="error">
            <AlertTitle>{t('barcodeScanner.error.title', 'Lookup failed')}</AlertTitle>
            <AlertDescription>
              <span className="block">{state.message}</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {t('barcodeScanner.scanned.label', 'Scanned code')}: {state.code}
              </span>
            </AlertDescription>
          </Alert>
        ) : null}

        {state.kind === 'empty' ? (
          <EmptyState
            variant="subtle"
            icon={<ScanLine className="size-6" aria-hidden="true" />}
            title={t('barcodeScanner.empty.title', 'No variant matches this barcode')}
            description={t(
              'barcodeScanner.empty.description',
              'Nothing in the catalog matches {code}. Check the code and scan again.',
              { code: state.code },
            )}
            actions={
              <Button type="button" variant="outline" onClick={openScanner}>
                <ScanLine aria-hidden="true" />
                <span>{scanAgainLabel}</span>
              </Button>
            }
          />
        ) : null}

        {state.kind === 'multiple' ? (
          <Card>
            <CardHeader>
              <CardTitle>{t('barcodeScanner.multiple.title', 'Several variants match')}</CardTitle>
              <CardDescription>
                {t(
                  'barcodeScanner.multiple.description',
                  '{count} variants match {code}. Pick the right one to open it.',
                  { count: state.candidates.length, code: state.code },
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <ul className="space-y-2">
                {state.candidates.map((candidate) => {
                  const name = candidate.name?.trim()
                    ? candidate.name
                    : t('barcodeScanner.chooser.unnamed', 'Unnamed variant')
                  return (
                    <li key={candidate.id}>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-auto w-full justify-start px-4 py-3 text-left"
                        aria-label={t('barcodeScanner.chooser.openAria', 'Open variant {name}', { name })}
                        onClick={() => openVariant(candidate, state.code)}
                      >
                        <span className="flex min-w-0 flex-col gap-1">
                          <span className="truncate text-sm font-medium">{name}</span>
                          <span className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                            <span>
                              {t('barcodeScanner.chooser.sku', 'SKU')}: {candidate.sku?.trim() || EMPTY_VALUE}
                            </span>
                            <span>
                              {t('barcodeScanner.chooser.barcode', 'Barcode')}:{' '}
                              {candidate.barcode?.trim() || EMPTY_VALUE}
                            </span>
                          </span>
                        </span>
                      </Button>
                    </li>
                  )
                })}
              </ul>
              <Button type="button" variant="ghost" onClick={openScanner}>
                <ScanLine aria-hidden="true" />
                <span>{scanAgainLabel}</span>
              </Button>
            </CardContent>
          </Card>
        ) : null}
      </PageBody>

      <BarcodeScannerDialog
        open={dialogOpen}
        onClose={closeScanner}
        onDetected={handleDetected}
        busy={busy}
        statusMessage={statusMessage}
        errorMessage={errorMessage}
      />
    </Page>
  )
}
