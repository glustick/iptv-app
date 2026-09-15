import { describe, it, expect } from 'vitest'
import { addStreamIds, kindOf, moveItem, removeStreamId } from './customCategories'

describe('moveItem', () => {
  it('moves an item forward and backward, returning a new array', () => {
    const list = ['a', 'b', 'c', 'd']
    expect(moveItem(list, 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveItem(list, 3, 1)).toEqual(['a', 'd', 'b', 'c'])
    expect(list).toEqual(['a', 'b', 'c', 'd'])
  })

  it('clamps out-of-range indices instead of throwing (a drop below the last row lands past the end)', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 99)).toEqual(['b', 'c', 'a'])
    expect(moveItem(['a', 'b', 'c'], -5, 1)).toEqual(['b', 'a', 'c'])
  })

  it('returns the SAME array when the move would be a no-op, so callers can skip a re-render', () => {
    const list = ['a', 'b', 'c']
    expect(moveItem(list, 1, 1)).toBe(list)
    expect(moveItem(['only'], 0, 0)).toEqual(['only'])
    expect(moveItem([], 0, 1)).toEqual([])
  })
})

describe('addStreamIds', () => {
  it('appends new ids in the caller\'s order and skips duplicates', () => {
    expect(addStreamIds([1, 2], [3, 1, 4, 2])).toEqual([1, 2, 3, 4])
  })

  it('returns the original ordering untouched when nothing is added', () => {
    expect(addStreamIds([5, 6], [])).toEqual([5, 6])
    expect(addStreamIds([5, 6], [5])).toEqual([5, 6])
  })
})

describe('removeStreamId', () => {
  it('removes the id, returning a new array', () => {
    expect(removeStreamId([1, 2, 3], 2)).toEqual([1, 3])
  })

  it('returns the SAME array when the id wasn\'t present', () => {
    const list = [1, 2]
    expect(removeStreamId(list, 9)).toBe(list)
  })
})

describe('kindOf', () => {
  it('treats a category saved before kinds existed as live', () => {
    expect(kindOf(undefined)).toBe('live')
    expect(kindOf({})).toBe('live')
  })

  it('passes through the explicit kinds', () => {
    expect(kindOf({ kind: 'movie' })).toBe('movie')
    expect(kindOf({ kind: 'series' })).toBe('series')
    expect(kindOf({ kind: 'live' })).toBe('live')
  })

  it('falls back to live for a corrupted value rather than losing the category', () => {
    expect(kindOf({ kind: 'nonsense' })).toBe('live')
  })
})
