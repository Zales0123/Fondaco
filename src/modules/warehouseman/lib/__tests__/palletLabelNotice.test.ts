import { beforeEach, describe, expect, it } from '@jest/globals'
import {
  clearPalletLabelNotices,
  stashPalletLabelNotice,
  takePalletLabelNotice,
} from '../palletLabelNotice'

describe('pallet label notice handoff', () => {
  beforeEach(() => clearPalletLabelNotices())

  it('carries what the printer answered into the pallet the screen navigates to', () => {
    stashPalletLabelNotice('pal-1', { kind: 'success', message: 'Etykieta palety jest drukowana.' })
    expect(takePalletLabelNotice('pal-1')).toEqual({
      kind: 'success',
      message: 'Etykieta palety jest drukowana.',
    })
  })

  it('reads a notice once: it is about one print, not about the screen', () => {
    stashPalletLabelNotice('pal-1', { kind: 'warning', message: 'Drukarka jest niedostępna.' })
    expect(takePalletLabelNotice('pal-1')).not.toBeNull()
    expect(takePalletLabelNotice('pal-1')).toBeNull()
  })

  it('never hands one pallet the notice of another', () => {
    stashPalletLabelNotice('pal-1', { kind: 'warning', message: 'Drukarka jest niedostępna.' })
    expect(takePalletLabelNotice('pal-2')).toBeNull()
    expect(takePalletLabelNotice('pal-1')).not.toBeNull()
  })

  it('answers nothing when no print preceded the navigation', () => {
    expect(takePalletLabelNotice('pal-1')).toBeNull()
  })

  it('keeps only the latest notice for a pallet', () => {
    stashPalletLabelNotice('pal-1', { kind: 'warning', message: 'Drukarka jest niedostępna.' })
    stashPalletLabelNotice('pal-1', { kind: 'success', message: 'Etykieta palety jest drukowana.' })
    expect(takePalletLabelNotice('pal-1')).toEqual({
      kind: 'success',
      message: 'Etykieta palety jest drukowana.',
    })
  })
})
