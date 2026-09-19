/**
 * The only file in this module that imports `serialport`.
 *
 * Everything else talks to `SerialTransport`, so the whole print job can be
 * exercised against a fake in unit tests with no hardware attached. `serialport`
 * is a native module and must stay in `serverExternalPackages` in next.config.ts.
 */
import type { SerialTransport } from './types'

/**
 * Matches `serial.Serial(portname)` in the reference script, which leaves
 * pyserial's 9600 default in place. The B1 is reached over Bluetooth RFCOMM,
 * where the baud rate is negotiated by the link and this value is ignored —
 * but there is no reason to diverge from the known-good configuration.
 */
export const DEFAULT_BAUD_RATE = 9600

export async function openSerialTransport(
  portPath: string,
  baudRate: number = DEFAULT_BAUD_RATE,
): Promise<SerialTransport> {
  // Imported lazily so that merely loading this module (during `yarn generate`,
  // route collection, or a test run) never pulls in the native binding.
  const { SerialPort } = await import('serialport')

  const port = await new Promise<InstanceType<typeof SerialPort>>((resolve, reject) => {
    const candidate = new SerialPort({ path: portPath, baudRate }, (error) => {
      if (error) reject(error)
      else resolve(candidate)
    })
  })

  return {
    async write(data) {
      await new Promise<void>((resolve, reject) => {
        port.write(data, (error) => (error ? reject(error) : resolve()))
      })
      // pyserial's writes block until the bytes are handed to the OS. Node
      // buffers them, so without an explicit drain the row packets can be
      // queued far faster than the printer consumes them.
      await new Promise<void>((resolve, reject) => {
        port.drain((error) => (error ? reject(error) : resolve()))
      })
    },
    onData(listener) {
      port.on('data', listener)
    },
    async close() {
      if (!port.isOpen) return
      await new Promise<void>((resolve) => {
        port.close(() => resolve())
      })
    },
  }
}
