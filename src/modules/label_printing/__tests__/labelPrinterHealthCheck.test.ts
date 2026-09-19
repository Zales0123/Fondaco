import { describe, expect, it } from '@jest/globals'
import { createLabelPrinterHealthCheck } from '../lib/labelPrinterHealthCheck'
import { createFakePrinter } from '../testing/fakeSerialTransport'
import type { LabelPrinterSettings } from '../lib/labelPrinterSettings'
import type { SerialTransport } from '../lib/types'

const scope = { tenantId: 't-1', organizationId: 'o-1' }

const preset: LabelPrinterSettings = {
  portPath: '/dev/tty.preset',
  density: 3,
  labelType: 1,
  jobTimeoutMs: 60_000,
  geometry: { width: 384, height: 230 },
}

function healthCheck(openTransport: (portPath: string) => Promise<SerialTransport>) {
  return createLabelPrinterHealthCheck({ readPreset: () => preset, openTransport })
}

describe('createLabelPrinterHealthCheck', () => {
  it('reports healthy when the port opens, and names the port it reached', async () => {
    const printer = createFakePrinter()
    const result = await healthCheck(async () => printer.transport).check(null, scope)

    expect(result.status).toBe('healthy')
    expect(result.details).toMatchObject({ portPath: '/dev/tty.preset' })
  })

  /** Opening is the whole probe, so leaving the handle behind would block the next print. */
  it('closes the port it opened', async () => {
    const printer = createFakePrinter()
    await healthCheck(async () => printer.transport).check(null, scope)

    expect(printer.closed).toBe(true)
  })

  it('probes the port the settings tab saved, not the deployment default', async () => {
    const opened: string[] = []
    const check = healthCheck(async (portPath) => {
      opened.push(portPath)
      return createFakePrinter().transport
    })

    await check.check({ portPath: '/dev/tty.B1-SAVED' }, scope)

    expect(opened).toEqual(['/dev/tty.B1-SAVED'])
  })

  it('reports unhealthy with the reason when the port will not open', async () => {
    const result = await healthCheck(async () => {
      throw new Error('Resource busy, cannot open /dev/tty.preset')
    }).check(null, scope)

    expect(result.status).toBe('unhealthy')
    expect(result.message).toMatch(/Resource busy/)
  })

  /**
   * A blanked port is a deliberate "no printer here", not a fault — the same answer the
   * print route gives with a 503. Reporting it unhealthy would put a red light on a
   * deployment that is configured exactly as its operator intended.
   */
  it('reports a switched-off printer as degraded rather than broken', async () => {
    let opened = false
    const result = await healthCheck(async () => {
      opened = true
      return createFakePrinter().transport
    }).check({ portPath: '' }, scope)

    expect(result.status).toBe('degraded')
    expect(opened).toBe(false)
  })
})
