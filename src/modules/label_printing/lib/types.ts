/** Transport seam: the print job depends on this, never on `serialport`. */
export type SerialTransport = {
  /** Resolves once the bytes have actually been flushed to the device. */
  write: (data: Buffer) => Promise<void>
  onData: (listener: (chunk: Buffer) => void) => void
  close: () => Promise<void>
}

export type SerialTransportFactory = (portPath: string) => Promise<SerialTransport>
