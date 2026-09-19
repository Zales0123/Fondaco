/**
 * Physical label geometry.
 *
 * Defaults to 50x30mm, the NiimBot B1's standard stock, at the ~7.68 dots/mm
 * the reference `niimctl` examples assume (`--export-width=384` for a 50mm
 * page). 384 is also divisible by 8, which the print head requires.
 *
 * Width is capped by the head at 400 dots; height is free (a u16 in the page
 * -size packet), so it is bounded only by the stock. Both are configurable
 * because the installed label stock is a property of the deployment, not of
 * the protocol — `labelPrinterSettings.ts` is what resolves them, from the
 * integration's settings tab over the `NIIMBOT_LABEL_*` preset.
 */
export type LabelGeometry = {
  width: number
  height: number
}

export const DEFAULT_LABEL_GEOMETRY: LabelGeometry = {
  width: 384,
  height: 230,
}

