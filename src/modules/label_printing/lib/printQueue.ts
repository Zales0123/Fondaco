/**
 * A label printer is an exclusive resource: two overlapping jobs would
 * interleave their packets on the same serial port and print garbage.
 *
 * Rather than queue work behind a possibly-wedged job, a second concurrent
 * request is refused outright so the caller can tell the user to try again.
 */
export class PrinterBusyError extends Error {
  readonly code = 'printer-busy' as const
  constructor(message = 'The label printer is already printing') {
    super(message)
    this.name = 'PrinterBusyError'
  }
}

export type ExclusiveRunner = <T>(job: () => Promise<T>) => Promise<T>

export function createExclusiveRunner(): ExclusiveRunner {
  let active = false
  return async function run<T>(job: () => Promise<T>): Promise<T> {
    if (active) throw new PrinterBusyError()
    active = true
    try {
      return await job()
    } finally {
      active = false
    }
  }
}
