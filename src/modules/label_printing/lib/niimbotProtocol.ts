/**
 * NiimBot B1 serial protocol — framing only, no I/O.
 *
 * Ported from the reference `niimctl.py`. Every framing rule here mirrors that
 * script byte for byte, because the protocol is undocumented and the printer is
 * the only oracle: a packet the script never sends is a packet nobody has ever
 * seen the B1 accept.
 *
 * Keeping this file pure (Buffer in, Buffer out) is what makes the rest of the
 * port testable without hardware attached.
 */

/** Command bytes, named from the reference script's comments. */
export const NiimbotCommand = {
  SetDensity: 0x21,
  SetLabelType: 0x23,
  PrintStart: 0x01,
  PageStart: 0x03,
  SetPageSize: 0x13,
  BlankRows: 0x84,
  PrintRow: 0x85,
  PageEnd: 0xe3,
  PrintStatus: 0xa3,
  PrintEnd: 0xf3,
} as const

export type NiimbotCommandCode = (typeof NiimbotCommand)[keyof typeof NiimbotCommand]

export type NiimbotPacket = {
  cmd: number
  payload: Buffer
}

const PACKET_HEAD = 0x55
const PACKET_TAIL = 0xaa
const MAX_PAYLOAD_LENGTH = 0xff

/** XOR of every byte from `cmd` through the end of `payload`. */
function checksum(cmd: number, payload: Buffer): number {
  let cks = cmd ^ payload.length
  for (const byte of payload) cks ^= byte
  return cks & 0xff
}

/**
 * Frame one command: `55 55 | cmd | len | payload | checksum | aa aa`.
 */
export function buildPacket(cmd: number, payload: Buffer | Uint8Array = Buffer.alloc(0)): Buffer {
  const body = Buffer.from(payload)
  if (body.length > MAX_PAYLOAD_LENGTH) {
    throw new Error(`Niimbot payload too long: ${body.length} bytes (max ${MAX_PAYLOAD_LENGTH})`)
  }
  return Buffer.concat([
    Buffer.from([PACKET_HEAD, PACKET_HEAD, cmd, body.length]),
    body,
    Buffer.from([checksum(cmd, body), PACKET_TAIL, PACKET_TAIL]),
  ])
}

type ParserState =
  | 'idle'
  | 'started'
  | 'cmd'
  | 'payloadLength'
  | 'payload'
  | 'checksum'
  | 'tail1'
  | 'tail2'

export type NiimbotParser = {
  /** Feed an arbitrary chunk; returns every packet completed by it. */
  push: (chunk: Buffer | Uint8Array) => NiimbotPacket[]
  /** Count of frames dropped for a bad checksum or bad tail bytes. */
  readonly malformedCount: number
}

/**
 * Incremental packet parser.
 *
 * Serial data arrives in arbitrary chunks, so unlike the Python version — which
 * can afford to block on `port.read()` one byte at a time — this has to survive
 * a packet split across any two reads. A malformed frame resyncs to `idle`
 * instead of aborting the job, since the B1 emits unsolicited packets mid-print.
 */
export function createNiimbotParser(): NiimbotParser {
  let state: ParserState = 'idle'
  let cmd = 0
  let payloadLength = 0
  let payload: number[] = []
  let malformed = 0

  const reset = () => {
    state = 'idle'
    payload = []
  }

  return {
    get malformedCount() {
      return malformed
    },
    push(chunk) {
      const packets: NiimbotPacket[] = []
      for (const byte of Buffer.from(chunk)) {
        switch (state) {
          case 'idle':
            if (byte === PACKET_HEAD) state = 'started'
            break
          case 'started':
            state = byte === PACKET_HEAD ? 'cmd' : 'idle'
            break
          case 'cmd':
            cmd = byte
            state = 'payloadLength'
            break
          case 'payloadLength':
            payloadLength = byte
            payload = []
            // The reference script mishandles a zero-length payload (it waits
            // for a byte that never comes). Real traffic never carries one, but
            // skipping straight to the checksum costs nothing and cannot hang.
            state = payloadLength === 0 ? 'checksum' : 'payload'
            break
          case 'payload':
            payload.push(byte)
            if (payload.length === payloadLength) state = 'checksum'
            break
          case 'checksum': {
            const body = Buffer.from(payload)
            if (byte !== checksum(cmd, body)) {
              malformed += 1
              reset()
              break
            }
            state = 'tail1'
            break
          }
          case 'tail1':
            if (byte !== PACKET_TAIL) {
              malformed += 1
              reset()
              break
            }
            state = 'tail2'
            break
          case 'tail2':
            if (byte !== PACKET_TAIL) {
              malformed += 1
              reset()
              break
            }
            packets.push({ cmd, payload: Buffer.from(payload) })
            reset()
            break
        }
      }
      return packets
    },
  }
}

export type NiimbotStatus = {
  pagesDone: number
  progress: number
  busy: number
  error: number
}

/**
 * Decode a `PrintStatus` (0xa3) response.
 *
 * The reference script reads five big-endian u16s out of the 10-byte payload
 * and discards the third; `progress` reaching 0x6464 means both the print and
 * feed halves report 100.
 */
export function parseStatusPayload(payload: Buffer): NiimbotStatus | null {
  if (payload.length < 10) return null
  return {
    pagesDone: payload.readUInt16BE(0),
    progress: payload.readUInt16BE(2),
    busy: payload.readUInt16BE(6),
    error: payload.readUInt16BE(8),
  }
}

/** The printer reports a finished page as progress 0x6464 with the busy flag clear. */
export const PRINT_PROGRESS_COMPLETE = 0x6464

export function isPrintComplete(status: NiimbotStatus, expectedPages: number): boolean {
  return (
    status.pagesDone >= expectedPages &&
    status.progress === PRINT_PROGRESS_COMPLETE &&
    status.busy === 0
  )
}
