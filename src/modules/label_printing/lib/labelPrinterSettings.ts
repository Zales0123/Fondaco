/**
 * The printer's configuration, and where it comes from.
 *
 * Two sources, in order: whatever an operator saved in the integration's settings tab,
 * over the env preset the deployment ships with. The preset is what makes the tab
 * optional — an app that never opens it behaves exactly as it did when these values were
 * only ever read from `NIIMBOT_*`.
 *
 * Everything is resolved per call rather than held, because the saved half is tenant-
 * scoped and read asynchronously from the credentials store, while the service that
 * consumes it is a process-wide singleton guarding one physical device.
 */
import { DEFAULT_LABEL_GEOMETRY, type LabelGeometry } from './labelGeometry'

export type LabelPrinterSettings = {
  /** Serial device the printer is paired on; `null` means printing is switched off. */
  portPath: string | null
  density: number
  labelType: number
  jobTimeoutMs: number
  geometry: LabelGeometry
}

/** Darkness levels the B1's print head actually has. */
const MIN_DENSITY = 1
const MAX_DENSITY = 5

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** The deployment's own configuration, used until somebody saves something else. */
export function readLabelPrinterPreset(): LabelPrinterSettings {
  const portPath = process.env.NIIMBOT_SERIAL_PORT?.trim()
  return {
    portPath: portPath && portPath.length > 0 ? portPath : null,
    density: readIntEnv('NIIMBOT_DENSITY', 3),
    labelType: readIntEnv('NIIMBOT_LABEL_TYPE', 1),
    jobTimeoutMs: readIntEnv('NIIMBOT_JOB_TIMEOUT_MS', 60_000),
    geometry: {
      width: readIntEnv('NIIMBOT_LABEL_WIDTH', DEFAULT_LABEL_GEOMETRY.width),
      height: readIntEnv('NIIMBOT_LABEL_HEIGHT', DEFAULT_LABEL_GEOMETRY.height),
    },
  }
}

/**
 * Reads one stored field as a positive integer.
 *
 * `CredentialFieldType` has no number, so the form stores every value as a string and a
 * blank or mistyped one is indistinguishable from "not set" at this layer. Both fall back
 * to the preset: it is a working configuration, and keeping it beats refusing to print.
 */
function readInt(stored: Record<string, unknown>, key: string, fallback: number): number {
  const raw = stored[key]
  if (typeof raw !== 'string' && typeof raw !== 'number') return fallback
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(raw.trim(), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function resolveLabelPrinterSettings(
  stored: Record<string, unknown> | null,
  preset: LabelPrinterSettings,
): LabelPrinterSettings {
  if (!stored) return preset

  const density = readInt(stored, 'density', preset.density)
  return {
    // A port present but blank is an operator saying "no printer here", which is an
    // answer in its own right — so it switches printing off rather than falling through
    // to the preset the way an absent field does.
    portPath: typeof stored.portPath === 'string'
      ? (stored.portPath.trim() || null)
      : preset.portPath,
    density: density >= MIN_DENSITY && density <= MAX_DENSITY ? density : preset.density,
    labelType: readInt(stored, 'labelType', preset.labelType),
    jobTimeoutMs: readInt(stored, 'jobTimeoutMs', preset.jobTimeoutMs),
    geometry: {
      width: readInt(stored, 'labelWidth', preset.geometry.width),
      height: readInt(stored, 'labelHeight', preset.geometry.height),
    },
  }
}
