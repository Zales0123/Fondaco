/**
 * Framing tests.
 *
 * `fixtures/packets.json` holds the exact bytes the reference `send_packet`
 * produces for every command the print job uses, so `buildPacket` is checked
 * against the Python output rather than against arithmetic re-derived here
 * (which would just repeat any mistake the port already made).
 */
import { describe, expect, it } from '@jest/globals'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  buildPacket,
  createNiimbotParser,
  isPrintComplete,
  parseStatusPayload,
  PRINT_PROGRESS_COMPLETE,
} from '../lib/niimbotProtocol'

type GoldenPacket = { cmd: number; payload: string; packet: string }

const golden: Record<string, GoldenPacket> = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures', 'packets.json'), 'utf8'),
)

describe('buildPacket', () => {
  it.each(Object.entries(golden))('matches the reference framing for %s', (_name, spec) => {
    const built = buildPacket(spec.cmd, Buffer.from(spec.payload, 'hex'))
    expect(built.toString('hex')).toBe(spec.packet)
  })

  it('rejects a payload longer than one length byte can describe', () => {
    expect(() => buildPacket(0x85, Buffer.alloc(256))).toThrow(/too long/)
  })
})

describe('createNiimbotParser', () => {
  it('round-trips every built packet', () => {
    const parser = createNiimbotParser()
    for (const spec of Object.values(golden)) {
      const [packet, ...rest] = parser.push(Buffer.from(spec.packet, 'hex'))
      expect(rest).toHaveLength(0)
      expect(packet.cmd).toBe(spec.cmd)
      expect(packet.payload.toString('hex')).toBe(spec.payload)
    }
    expect(parser.malformedCount).toBe(0)
  })

  it('reassembles a packet split across arbitrary chunk boundaries', () => {
    const frame = Buffer.from(golden.printRow.packet, 'hex')
    for (let split = 1; split < frame.length; split += 1) {
      const parser = createNiimbotParser()
      expect(parser.push(frame.subarray(0, split))).toHaveLength(0)
      const packets = parser.push(frame.subarray(split))
      expect(packets).toHaveLength(1)
      expect(packets[0].payload.toString('hex')).toBe(golden.printRow.payload)
    }
  })

  it('emits several packets arriving in one chunk', () => {
    const parser = createNiimbotParser()
    const chunk = Buffer.concat([
      Buffer.from(golden.pageStart.packet, 'hex'),
      Buffer.from(golden.pageEnd.packet, 'hex'),
    ])
    expect(parser.push(chunk).map((p) => p.cmd)).toEqual([0x03, 0xe3])
  })

  it('drops a frame with a bad checksum and resyncs to the next one', () => {
    const parser = createNiimbotParser()
    const corrupt = Buffer.from(golden.pageStart.packet, 'hex')
    corrupt[corrupt.length - 3] ^= 0xff
    expect(parser.push(corrupt)).toHaveLength(0)
    expect(parser.malformedCount).toBe(1)

    expect(parser.push(Buffer.from(golden.pageEnd.packet, 'hex'))).toHaveLength(1)
  })

  it('drops a frame with bad tail bytes', () => {
    const parser = createNiimbotParser()
    const corrupt = Buffer.from(golden.pageStart.packet, 'hex')
    corrupt[corrupt.length - 1] = 0x00
    expect(parser.push(corrupt)).toHaveLength(0)
    expect(parser.malformedCount).toBe(1)
  })

  it('ignores line noise before a frame', () => {
    const parser = createNiimbotParser()
    const noisy = Buffer.concat([
      Buffer.from([0x00, 0xff, 0x55, 0x12]),
      Buffer.from(golden.pageStart.packet, 'hex'),
    ])
    expect(parser.push(noisy)).toHaveLength(1)
  })

  it('handles a zero-length payload without stalling', () => {
    const parser = createNiimbotParser()
    const packets = parser.push(buildPacket(0xa3))
    expect(packets).toHaveLength(1)
    expect(packets[0].payload).toHaveLength(0)
  })
})

describe('parseStatusPayload', () => {
  it('decodes the ten-byte status payload', () => {
    const payload = Buffer.alloc(10)
    payload.writeUInt16BE(1, 0)
    payload.writeUInt16BE(PRINT_PROGRESS_COMPLETE, 2)
    payload.writeUInt16BE(0, 6)
    payload.writeUInt16BE(0, 8)

    const status = parseStatusPayload(payload)
    expect(status).toEqual({ pagesDone: 1, progress: PRINT_PROGRESS_COMPLETE, busy: 0, error: 0 })
    expect(isPrintComplete(status!, 1)).toBe(true)
  })

  it('returns null for a short payload', () => {
    expect(parseStatusPayload(Buffer.alloc(4))).toBeNull()
  })

  it('is not complete while the printer is still busy', () => {
    const status = { pagesDone: 1, progress: PRINT_PROGRESS_COMPLETE, busy: 1, error: 0 }
    expect(isPrintComplete(status, 1)).toBe(false)
  })
})
