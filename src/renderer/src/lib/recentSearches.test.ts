import { describe, expect, it } from 'vitest'
import {
  loadRecentSearches,
  MAX_RECENT_SEARCHES,
  recordRecentSearch,
  RECENT_PROGRAMME_SEARCHES_KEY
} from './recentSearches'

function storage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size
    }
  }
}

describe('recent programme searches (0.33.0)', () => {
  it('loads an empty list when nothing was recorded', () => {
    expect(loadRecentSearches(storage())).toEqual([])
    expect(loadRecentSearches(storage({ [RECENT_PROGRAMME_SEARCHES_KEY]: 'not json' }))).toEqual([])
    expect(loadRecentSearches(storage({ [RECENT_PROGRAMME_SEARCHES_KEY]: '"random"' }))).toEqual([])
    expect(
      loadRecentSearches(storage({ [RECENT_PROGRAMME_SEARCHES_KEY]: JSON.stringify(['ok', 7, null]) }))
    ).toEqual(['ok'])
  })

  it('records an acted-on query, most recent first', () => {
    const store = storage()
    expect(recordRecentSearch('match of the day', store)).toEqual(['match of the day'])
    expect(recordRecentSearch("one's next", store)).toEqual(["one's next", 'match of the day'])
    expect(store.getItem(RECENT_PROGRAMME_SEARCHES_KEY)).toBe(JSON.stringify(["one's next", 'match of the day']))
  })

  it('a repeated query moves to the front instead of duplicating', () => {
    const store = storage()
    recordRecentSearch('news', store)
    recordRecentSearch('sport', store)
    expect(recordRecentSearch('news', store)).toEqual(['news', 'sport'])
  })

  it('trims before recording and ignores empty queries', () => {
    const store = storage()
    expect(recordRecentSearch('  news  ', store)).toEqual(['news'])
    expect(recordRecentSearch('   ', store)).toEqual(['news'])
  })

  it('keeps only the last five', () => {
    const store = storage()
    for (let i = 1; i <= MAX_RECENT_SEARCHES + 2; i++) recordRecentSearch(`query ${i}`, store)
    expect(loadRecentSearches(store)).toEqual(['query 7', 'query 6', 'query 5', 'query 4', 'query 3'])
  })
})
