import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerConnectionHolder,
  releaseConnectionHolder,
  listConnectionHolders,
  describeConnectionHolders
} from './connectionLedger'

describe('connectionLedger', () => {
  beforeEach(() => {
    for (const h of listConnectionHolders()) releaseConnectionHolder(h.id)
  })

  it('registers and releases by id, oldest first', () => {
    registerConnectionHolder('player', 'Player — BBC One', 1000)
    registerConnectionHolder('recording', 'Recording — Sky News', 2000)
    expect(listConnectionHolders().map((h) => h.label)).toEqual(['Player — BBC One', 'Recording — Sky News'])
    releaseConnectionHolder('player')
    expect(listConnectionHolders().map((h) => h.label)).toEqual(['Recording — Sky News'])
  })

  it('re-registering the same id updates in place instead of doubling', () => {
    registerConnectionHolder('player', 'Player — BBC One', 1000)
    registerConnectionHolder('player', 'Player — Sky News', 2000)
    expect(listConnectionHolders()).toHaveLength(1)
    expect(listConnectionHolders()[0].label).toBe('Player — Sky News')
  })

  it('a release of an unknown id is a harmless no-op', () => {
    expect(() => releaseConnectionHolder('never-registered')).not.toThrow()
  })

  it('describes an empty ledger honestly', () => {
    expect(describeConnectionHolders()).toBe('none')
    registerConnectionHolder('player', 'Player — BBC One', 1000)
    expect(describeConnectionHolders()).toBe('Player — BBC One')
  })
})
