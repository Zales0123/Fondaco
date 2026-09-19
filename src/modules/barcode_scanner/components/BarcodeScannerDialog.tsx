'use client'

import * as React from 'react'
import { Camera, Flashlight, FlashlightOff, RefreshCw, ScanLine } from 'lucide-react'
import {
  BarcodeDetector as BarcodeDetectorPonyfill,
  prepareZXingModule,
  type BarcodeFormat,
} from 'barcode-detector/ponyfill'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@open-mercato/ui/primitives/dialog'
import { Alert, AlertDescription, AlertTitle } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Label } from '@open-mercato/ui/primitives/label'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { cn } from '@open-mercato/shared/lib/utils'
import { useT } from '@open-mercato/shared/lib/i18n/context'

export type BarcodeScannerDialogProps = {
  /** Controls visibility. When false the camera MUST be fully released. */
  open: boolean
  /** User dismissed the dialog. */
  onClose: () => void
  /** A barcode was decoded (camera) or typed (manual fallback). Raw string value. */
  onDetected: (code: string) => void
  /** Parent is busy resolving the code (e.g. API lookup in flight). */
  busy?: boolean
  /** Optional status line rendered by the parent (e.g. "Looking up 5901234123457…"). */
  statusMessage?: string | null
  /** Optional error rendered by the parent (e.g. "No variant matches this barcode."). */
  errorMessage?: string | null
}

/** Poll cadence for `detect()`. 100ms keeps mobile CPUs (and battery) sane. */
const SCAN_INTERVAL_MS = 100

/** Self-hosted ZXing binary — see `public/zxing/zxing_reader.wasm`. */
const ZXING_WASM_URL = '/zxing/zxing_reader.wasm'

const BARCODE_FORMATS: BarcodeFormat[] = [
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
  'code_128',
  'code_39',
  'itf',
  'qr_code',
  'data_matrix',
]

/** Minimal structural view of both the native and the ponyfill detector. */
type BarcodeDetectorLike = {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>
}

type BarcodeDetectorCtor = new (options?: { formats?: BarcodeFormat[] }) => BarcodeDetectorLike

/** `torch` is not in the standard lib typings yet (Chromium-only capability). */
type TorchCapabilities = MediaTrackCapabilities & { torch?: boolean }
type TorchConstraintSet = MediaTrackConstraintSet & { torch?: boolean }

type CameraErrorKind = 'insecure' | 'unsupported' | 'denied' | 'notFound' | 'generic'

// `prepareZXingModule` is global to the ponyfill, so it must run exactly once
// and never during SSR — hence the module-level latch plus the lazy call site.
let zxingPrepared = false

function prepareSelfHostedZXing(): void {
  if (zxingPrepared) return
  zxingPrepared = true
  prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) =>
        path.endsWith('.wasm') ? ZXING_WASM_URL : `${prefix}${path}`,
    },
  })
}

function createDetector(): BarcodeDetectorLike {
  // Native detector (Android Chrome) decodes far faster than the WASM path.
  // Safari and Firefox ship none, so the ponyfill is what actually runs there.
  const nativeCtor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
  if (nativeCtor) return new nativeCtor({ formats: BARCODE_FORMATS })
  prepareSelfHostedZXing()
  return new BarcodeDetectorPonyfill({ formats: BARCODE_FORMATS })
}

function classifyCameraError(error: unknown): CameraErrorKind {
  const name = error instanceof Error ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return 'denied'
  }
  if (
    name === 'NotFoundError'
    || name === 'OverconstrainedError'
    || name === 'DevicesNotFoundError'
  ) {
    return 'notFound'
  }
  return 'generic'
}

export function BarcodeScannerDialog({
  open,
  onClose,
  onDetected,
  busy = false,
  statusMessage = null,
  errorMessage = null,
}: BarcodeScannerDialogProps): React.JSX.Element | null {
  const t = useT()

  const videoRef = React.useRef<HTMLVideoElement | null>(null)
  const streamRef = React.useRef<MediaStream | null>(null)
  const trackRef = React.useRef<MediaStreamTrack | null>(null)
  const detectorRef = React.useRef<BarcodeDetectorLike | null>(null)
  const intervalRef = React.useRef<number | null>(null)
  const detectingRef = React.useRef(false)
  const firedRef = React.useRef(false)
  const onDetectedRef = React.useRef(onDetected)

  const [attempt, setAttempt] = React.useState(0)
  const [starting, setStarting] = React.useState(false)
  const [cameraError, setCameraError] = React.useState<CameraErrorKind | null>(null)
  const [torchSupported, setTorchSupported] = React.useState(false)
  const [torchOn, setTorchOn] = React.useState(false)
  const [captured, setCaptured] = React.useState(false)
  const [manualValue, setManualValue] = React.useState('')

  React.useEffect(() => {
    onDetectedRef.current = onDetected
  }, [onDetected])

  const stopCamera = React.useCallback(() => {
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    detectingRef.current = false
    const stream = streamRef.current
    if (stream) {
      for (const track of stream.getTracks()) track.stop()
      streamRef.current = null
    }
    trackRef.current = null
    const video = videoRef.current
    if (video) {
      video.pause()
      video.srcObject = null
    }
    setTorchSupported(false)
    setTorchOn(false)
  }, [])

  React.useEffect(() => {
    if (!open) return
    setManualValue('')
  }, [open])

  React.useEffect(() => {
    if (!open) return undefined

    let cancelled = false
    firedRef.current = false
    detectingRef.current = false
    setCaptured(false)
    setCameraError(null)
    setStarting(true)

    const runTick = async () => {
      const video = videoRef.current
      const detector = detectorRef.current
      if (!video || !detector) return
      if (detectingRef.current || firedRef.current) return
      // HAVE_CURRENT_DATA — nothing decodable before the first frame lands.
      if (video.readyState < 2) return
      detectingRef.current = true
      try {
        const results = await detector.detect(video)
        const rawValue = results.length > 0 ? results[0].rawValue : ''
        if (rawValue && !firedRef.current && !cancelled) {
          firedRef.current = true
          stopCamera()
          setCaptured(true)
          onDetectedRef.current(rawValue)
        }
      } catch {
        // A single failed decode pass is normal (blur, glare, no code in frame).
      } finally {
        detectingRef.current = false
      }
    }

    const startCamera = async () => {
      if (typeof window === 'undefined') return
      if (window.isSecureContext === false) {
        setCameraError('insecure')
        setStarting(false)
        return
      }
      const mediaDevices = navigator.mediaDevices
      if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
        setCameraError('unsupported')
        setStarting(false)
        return
      }
      try {
        const stream = await mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        })
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop()
          return
        }
        streamRef.current = stream
        const [videoTrack] = stream.getVideoTracks()
        if (videoTrack) {
          trackRef.current = videoTrack
          if (typeof videoTrack.getCapabilities === 'function') {
            const capabilities = videoTrack.getCapabilities() as TorchCapabilities
            setTorchSupported(capabilities.torch === true)
          }
        }
        const video = videoRef.current
        if (video) {
          video.srcObject = stream
          try {
            await video.play()
          } catch {
            // Autoplay rejection is recoverable — the poll loop waits for frames.
          }
        }
        if (cancelled) return
        detectorRef.current = createDetector()
        setStarting(false)
        intervalRef.current = window.setInterval(() => {
          void runTick()
        }, SCAN_INTERVAL_MS)
      } catch (error) {
        if (cancelled) return
        setCameraError(classifyCameraError(error))
        setStarting(false)
      }
    }

    void startCamera()

    return () => {
      cancelled = true
      stopCamera()
    }
  }, [open, attempt, stopCamera])

  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (!next) onClose()
    },
    [onClose],
  )

  const handleRestart = React.useCallback(() => {
    stopCamera()
    firedRef.current = false
    setCaptured(false)
    setCameraError(null)
    setAttempt((value) => value + 1)
  }, [stopCamera])

  const handleToggleTorch = React.useCallback(() => {
    const track = trackRef.current
    if (!track) return
    const next = !torchOn
    const constraintSet: TorchConstraintSet = { torch: next }
    track
      .applyConstraints({ advanced: [constraintSet] })
      .then(() => {
        setTorchOn(next)
      })
      .catch(() => {
        setTorchSupported(false)
      })
  }, [torchOn])

  const submitManual = React.useCallback(() => {
    if (busy) return
    const trimmed = manualValue.trim()
    if (!trimmed) return
    onDetectedRef.current(trimmed)
  }, [busy, manualValue])

  const handleDialogKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        submitManual()
      }
    },
    [submitManual],
  )

  const handleManualKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      submitManual()
    },
    [submitManual],
  )

  const cameraErrorCopy = React.useMemo<{ title: string; body: string } | null>(() => {
    switch (cameraError) {
      case 'insecure':
        return {
          title: t('barcodeScanner.scanner.errorInsecureTitle', 'Camera needs a secure connection'),
          body: t(
            'barcodeScanner.scanner.errorInsecureBody',
            'Browsers only grant camera access over HTTPS or on localhost. Open this page over HTTPS, then try again. Typing the barcode below works right now.',
          ),
        }
      case 'unsupported':
        return {
          title: t('barcodeScanner.scanner.errorUnsupportedTitle', 'Camera is not supported here'),
          body: t(
            'barcodeScanner.scanner.errorUnsupportedBody',
            'This browser does not expose a camera to web pages. Try a recent Chrome, Safari or Firefox, or type the barcode below.',
          ),
        }
      case 'denied':
        return {
          title: t('barcodeScanner.scanner.errorDeniedTitle', 'Camera permission denied'),
          body: t(
            'barcodeScanner.scanner.errorDeniedBody',
            'Allow camera access for this site in your browser settings — usually the padlock or camera icon in the address bar — then try again.',
          ),
        }
      case 'notFound':
        return {
          title: t('barcodeScanner.scanner.errorNotFoundTitle', 'No usable camera found'),
          body: t(
            'barcodeScanner.scanner.errorNotFoundBody',
            'We could not find a camera that matches the scanner requirements. Connect a camera or type the barcode below.',
          ),
        }
      case 'generic':
        return {
          title: t('barcodeScanner.scanner.errorGenericTitle', 'Could not start the camera'),
          body: t(
            'barcodeScanner.scanner.errorGenericBody',
            'Something went wrong while starting the camera. Try again, or type the barcode below.',
          ),
        }
      default:
        return null
    }
  }, [cameraError, t])

  if (!open) return null

  const manualInputId = 'barcode-scanner-manual-entry'
  const manualDisabled = busy || manualValue.trim().length === 0

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        onKeyDown={handleDialogKeyDown}
        closeAriaLabel={t('barcodeScanner.scanner.close', 'Close')}
      >
        <DialogHeader leading={<ScanLine aria-hidden="true" />} leadingTone="accent">
          <DialogTitle>{t('barcodeScanner.scanner.title', 'Scan a barcode')}</DialogTitle>
          <DialogDescription>
            {t(
              'barcodeScanner.scanner.description',
              'Point the rear camera at a barcode. You can also type the code by hand.',
            )}
          </DialogDescription>
        </DialogHeader>

        {cameraErrorCopy ? (
          <Alert
            status="error"
            size="default"
            footer={
              <Button type="button" variant="outline" size="sm" onClick={handleRestart}>
                <RefreshCw aria-hidden="true" />
                {t('barcodeScanner.scanner.tryAgain', 'Try again')}
              </Button>
            }
          >
            <AlertTitle>{cameraErrorCopy.title}</AlertTitle>
            <AlertDescription>{cameraErrorCopy.body}</AlertDescription>
          </Alert>
        ) : null}

        <div
          className={cn(
            'relative w-full overflow-hidden rounded-md border border-input bg-muted aspect-video',
            cameraErrorCopy ? 'hidden' : '',
          )}
        >
          <video
            ref={videoRef}
            className="h-full w-full object-cover"
            playsInline
            muted
            autoPlay
            aria-label={t(
              'barcodeScanner.scanner.cameraPreviewLabel',
              'Live camera preview used to scan barcodes',
            )}
          />
          {starting ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-muted">
              <Spinner size="md" />
              <span className="text-sm text-muted-foreground">
                {t('barcodeScanner.scanner.starting', 'Starting the camera…')}
              </span>
            </div>
          ) : null}
          {captured ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-muted">
              <Camera aria-hidden="true" className="size-6 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                {t('barcodeScanner.scanner.capturedHint', 'Barcode captured. The camera is off.')}
              </span>
            </div>
          ) : null}
        </div>

        {!cameraErrorCopy && (torchSupported || captured) ? (
          <div className="flex flex-wrap items-center gap-2">
            {torchSupported ? (
              <Button type="button" variant="outline" onClick={handleToggleTorch} aria-pressed={torchOn}>
                {torchOn ? <FlashlightOff aria-hidden="true" /> : <Flashlight aria-hidden="true" />}
                {torchOn
                  ? t('barcodeScanner.scanner.torchOff', 'Turn the light off')
                  : t('barcodeScanner.scanner.torchOn', 'Turn the light on')}
              </Button>
            ) : null}
            {captured ? (
              <Button type="button" variant="outline" onClick={handleRestart}>
                <RefreshCw aria-hidden="true" />
                {t('barcodeScanner.scanner.scanAgain', 'Scan again')}
              </Button>
            ) : null}
          </div>
        ) : null}

        {statusMessage ? (
          <Alert status="information" aria-live="polite">
            <AlertDescription className="flex items-center gap-2">
              {busy ? <Spinner size="sm" /> : null}
              <span>{statusMessage}</span>
            </AlertDescription>
          </Alert>
        ) : null}

        {errorMessage ? (
          <Alert status="error">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-col gap-2">
          <Label htmlFor={manualInputId}>
            {t('barcodeScanner.scanner.manualLabel', 'Or enter the barcode manually')}
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id={manualInputId}
              value={manualValue}
              onChange={(event) => setManualValue(event.target.value)}
              onKeyDown={handleManualKeyDown}
              inputMode="text"
              autoComplete="off"
              disabled={busy}
              placeholder={t('barcodeScanner.scanner.manualPlaceholder', 'e.g. 5901234123457')}
            />
            <Button type="button" onClick={submitManual} disabled={manualDisabled}>
              {busy ? <Spinner size="sm" /> : null}
              {t('barcodeScanner.scanner.manualSubmit', 'Use this code')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default BarcodeScannerDialog
