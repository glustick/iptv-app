import { describe, it, expect } from 'vitest'
import { categoryVisibilityKey, visibleCategories, hiddenCategories } from './categoryVisibility'

const cats = [
  { category_id: '10', name: 'Live News' },
  { category_id: '40', name: 'Football' },
  { category_id: '60', name: 'NFL' }
]

describe('categoryVisibilityKey', () => {
  it('scopes to the playlist, bare for the primary', () => {
    expect(categoryVisibilityKey(null, '10')).toBe('10')
    expect(categoryVisibilityKey('mock-test-2', '10')).toBe('mock-test-2:10')
  })
})

describe('visibleCategories / hiddenCategories', () => {
  it('splits a category list around the hidden set, preserving order in both halves', () => {
    const hidden = [categoryVisibilityKey(null, '40')]
    expect(visibleCategories(cats, null, hidden)).toEqual([cats[0], cats[2]])
    expect(hiddenCategories(cats, null, hidden)).toEqual([cats[1]])
  })

  it('is playlist-scoped — the same id on another playlist stays visible', () => {
    const hidden = ['mock-test-2:10']
    expect(visibleCategories(cats, null, hidden)).toEqual(cats)
    expect(hiddenCategories(cats, null, hidden)).toEqual([])
  })

  it('answers honestly on an empty set', () => {
    expect(visibleCategories(cats, null, [])).toEqual(cats)
    expect(hiddenCategories(cats, null, [])).toEqual([])
  })
})
