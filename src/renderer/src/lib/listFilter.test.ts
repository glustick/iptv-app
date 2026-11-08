import { describe, expect, it } from 'vitest'
import { foldListText, matchesFoldedQuery } from './listFilter'

describe('foldListText', () => {
  it('folds case and accents, so a typed "cafe" finds "Café"', () => {
    expect(foldListText('Café')).toBe('cafe')
    expect(foldListText('CAFÉ ROYAL')).toBe('cafe royal')
    expect(foldListText('Amélie')).toBe('amelie')
    expect(foldListText('Ça va')).toBe('ca va')
  })

  it('collapses whitespace runs and trims', () => {
    expect(foldListText('  The   Long   Read ')).toBe('the long read')
  })

  it('leaves plain ASCII alone', () => {
    expect(foldListText('Sky Sports F1')).toBe('sky sports f1')
  })
})

describe('matchesFoldedQuery', () => {
  it('matches case-insensitively through the cheap ASCII path', () => {
    expect(matchesFoldedQuery('Sky Sports Main Event', 'sky sports')).toBe(true)
    expect(matchesFoldedQuery('Sky Sports Main Event', 'main event')).toBe(true)
    expect(matchesFoldedQuery('Sky Sports Main Event', 'bbc')).toBe(false)
  })

  it('folds an accented name when the query is plain ASCII', () => {
    expect(matchesFoldedQuery('Café Royal', 'cafe')).toBe(true)
    expect(matchesFoldedQuery('Amélie', 'amelie')).toBe(true)
  })

  it('treats an empty query as no filter', () => {
    expect(matchesFoldedQuery('Anything', '')).toBe(true)
    expect(matchesFoldedQuery('', '')).toBe(true)
  })

  it('does not pretend to fold what is not a diacritic', () => {
    // ß is a letter, not a combining mark — folding it would need a transliteration table, and
    // silently doing half of one is worse than doing none.
    expect(matchesFoldedQuery('Straße', 'strasse')).toBe(false)
    expect(matchesFoldedQuery('Straße', 'straße')).toBe(true)
  })
})
