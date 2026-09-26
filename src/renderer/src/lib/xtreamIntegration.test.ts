import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startMockXtreamServer, type MockXtreamServer } from './testFixtures/mockXtreamServer'
import { XtreamClient } from './xtream'
import { matchXmltvChannels, parseXmltv } from './epg'
import { useAppStore } from '../store/useAppStore'
import { DEFAULT_SETTINGS } from './types'

// End-to-end integration over a real socket: the app's real XtreamClient and the real store drive a
// local synthetic provider (see testFixtures/mockXtreamServer.ts). Nothing here is mocked — fetch,
// the HTTP server, the XMLTV parser, the matching tiers and the pool are all the production code
// paths. This is what makes the EPG pipeline testable while the real provider is unavailable.
describe('Xtream client + EPG pipeline against a synthetic provider', () => {
  let mock: MockXtreamServer
  let client: XtreamClient

  beforeAll(async () => {
    mock = await startMockXtreamServer()
    client = new XtreamClient(mock.url, 'user', 'pass')
  })

  afterAll(async () => {
    await mock.close()
  })

  beforeEach(() => {
    useAppStore.setState({
      client: null,
      proxyBase: null,
      liveStreams: [],
      epgSources: [],
      epgSourceLabels: [],
      epgSourceByStream: {},
      epgSourceIssues: {},
      epgSourceMatchStats: [],
      shortEpgByStream: {},
      shortEpgFetchedAt: {},
      providerGuideAvailable: null,
      settings: DEFAULT_SETTINGS
    })
  })

  it('authenticates and reports the account', async () => {
    const auth = await client.authenticate()
    expect(auth.user_info.auth).toBe(1)
    expect(auth.user_info.max_connections).toBe('2')
    expect(auth.server_info.timezone).toBe('UTC')
  })

  it('lists the provider catalogue', async () => {
    const categories = await client.getLiveCategories()
    expect(categories.map((c) => c.category_name)).toEqual(['Live News', 'Live | Football', 'Live | Football Backup', 'USA | NFL'])

    const streams = await client.getLiveStreams()
    // Three guide-covered channels plus the deliberately-unplaceable residue one, plus the
    // six Sports-tab fixtures (see the fixture's own comment).
    expect(streams).toHaveLength(10)
    expect(streams.map((s) => s.stream_id)).toContain(mock.ids.channelMatchedById)

    // …and the same via a category filter, which is how the store loads a browsed category.
    const filtered = await client.getLiveStreams(mock.ids.categoryLive)
    expect(filtered).toHaveLength(4)
  })

  it('decodes per-channel short EPG', async () => {
    const listings = await client.getShortEpg(mock.ids.channelMatchedById, 48)
    expect(listings).toHaveLength(1)
    // Titles arrive base64-encoded from a real panel; the client decodes them.
    expect(listings[0].title).toBe('Short EPG Title')
    // A channel the provider has nothing for stays honestly empty rather than inventing rows.
    expect(await client.getShortEpg(mock.ids.channelMatchedByFuzzyName, 48)).toEqual([])
  })

  it('parses the full guide and matches it tier by tier', async () => {
    const xml = await client.getFullEpgXml()
    const guide = parseXmltv(xml)
    expect(guide.channels.size).toBe(3)

    const streams = await client.getLiveStreams()
    const matches = matchXmltvChannels(streams, guide)

    // Matched on the provider's own id…
    expect(matches.get(mock.ids.channelMatchedById)).toMatchObject({ channelId: 'one.hd', method: 'id' })
    // …matched only through the relaxed tier ("101 Two HD" → "Two")…
    expect(matches.get(mock.ids.channelMatchedByFuzzyName)).toMatchObject({ channelId: 'two.uk', method: 'fuzzy' })
    // …and honestly unmatched, which is the number the settings report exists to show. The residue
    // channel is unmatched too: its name is close to a guide entry but not close enough to join.
    expect(matches.has(mock.ids.channelUnmatchedByProviderGuide)).toBe(false)
    expect(matches.has(mock.ids.channelResidue)).toBe(false)
  })

  it('loads both the provider guide and a custom source through the real store, then prefills the grid', async () => {
    useAppStore.setState({
      client,
      proxyBase: mock.url,
      liveStreams: await client.getLiveStreams(),
      settings: {
        ...DEFAULT_SETTINGS,
        // Reached through the app's own /__fetch/ passthrough, which the fixture serves too.
        customEpgUrls: [`${mock.url}/custom-guide.xml`]
      }
    })

    await useAppStore.getState().loadEpgSources()

    const state = useAppStore.getState()
    expect(state.providerGuideAvailable).toBe(true)
    expect(state.epgSourceLabels).toHaveLength(2)
    expect(state.epgSourceIssues).toEqual({})

    // The provider guide covers two of three channels — one by id, one only via the relaxed tier.
    expect(state.epgSourceMatchStats[0]).toMatchObject({
      source: 'Provider guide (xmltv.php)',
      available: true,
      // 4 guide-covered fixture channels + 6 Sports-tab fixtures.
      loadedChannels: 10,
      matched: 2,
      byId: 1,
      byFuzzy: 1
    })
    // The custom source picks up the channel the provider's guide misses, by exact name.
    expect(state.epgSourceMatchStats[1]).toMatchObject({ matched: 1, byName: 1 })

    // And the pool actually prefilled each channel's timeline from the right source.
    expect(state.shortEpgByStream[mock.ids.channelMatchedById]?.[0]?.title).toBe("One's Show")
    expect(state.shortEpgByStream[mock.ids.channelMatchedByFuzzyName]?.[0]?.title).toBe("Two's Show")
    expect(state.shortEpgByStream[mock.ids.channelUnmatchedByProviderGuide]?.[0]?.title).toBe('Found Only Here')
    expect(state.epgSourceByStream[mock.ids.channelUnmatchedByProviderGuide]).toBe(`${mock.url}/custom-guide.xml`)
  })
})
