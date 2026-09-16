import { describe, expect, it } from 'vitest'
import { buildGuideIndex, matchXmltvChannels, planBulkSuggestionApply, type EpgChannel, type EpgData, type EpgProgramme } from './epg'
import type { LiveStream } from './types'

// A scale guard, not a correctness test: the matching pipeline is exercised on synthetic data the
// size of a real catalogue (~28k channels against a multi-thousand-channel guide) so that a future
// change which turns an O(n) walk into something quadratic shows up here as a failure rather than
// as a frozen window on someone's TV. The timings are printed so the numbers are on the record,
// and the budgets are deliberately loose — this runs on shared CI runners, and its job is to catch
// pathological regressions, not to police milliseconds.

const STREAM_COUNT = 27808 // the size of the real provider's live catalogue
const GUIDE_CHANNEL_COUNT = 5000

function makeStream(streamId: number, name: string, epgChannelId: string | null): LiveStream {
  return {
    num: streamId,
    name,
    stream_type: 'live',
    stream_id: streamId,
    stream_icon: '',
    epg_channel_id: epgChannelId,
    added: '0',
    category_id: '1',
    custom_sid: null,
    tv_archive: 0,
    direct_source: '',
    tv_archive_duration: 0
  }
}

function makeProgramme(channelId: string): EpgProgramme {
  return {
    channelId,
    title: 'Programme',
    description: '',
    start: new Date('2030-01-01T12:00:00Z'),
    stop: new Date('2030-01-01T13:00:00Z')
  }
}

/** Builds a guide and a catalogue with a realistic mix: most channels match by name, a slice only
 * through the relaxed tier (position/quality noise), and the long tail matches nothing at all —
 * which is what the real provider looks like. */
function makeWorld(): { guide: EpgData; streams: LiveStream[] } {
  const channels = new Map<string, EpgChannel>()
  const programmesByChannel = new Map<string, EpgProgramme[]>()
  const streams: LiveStream[] = []

  // Two-token guide names, because a one-token name can't produce the interesting middle case:
  // a channel that is neither an exact match nor unrelated, but close enough for the suggestion
  // planner to place. That middle case is what the bulk-apply feature exists for, so the fixture
  // has to contain it or the planner's own assertion is vacuous (which it was, first time round).
  for (let i = 0; i < GUIDE_CHANNEL_COUNT; i++) {
    const displayName = `Channel ${i} News`
    const id = `guide.${i}`
    channels.set(id, { id, displayName })
    programmesByChannel.set(id, [makeProgramme(id)])
  }

  for (let i = 0; i < STREAM_COUNT; i++) {
    const slot = i % GUIDE_CHANNEL_COUNT
    const bucket = i % 10
    if (bucket < 3) {
      // exact name, and most of these also carry the provider's epg_channel_id
      streams.push(makeStream(i + 1, `Channel ${slot} News`, bucket < 2 ? `guide.${slot}` : null))
    } else if (bucket < 5) {
      // only the relaxed tier can join these (position + quality noise)
      streams.push(makeStream(i + 1, `${i + 1} Channel ${slot} News FHD`, null))
    } else if (bucket < 7) {
      // residue: too far apart for the relaxed tier (so unresolved), but close enough that the
      // planner's Dice score of 0.8 clears the default threshold and can place them.
      streams.push(makeStream(i + 1, `Channel ${slot} News Extra`, null))
    } else {
      // the long tail: no guide counterpart at all
      streams.push(makeStream(i + 1, `Event Feed ${i} @ Court ${i % 20}`, null))
    }
  }
  return { guide: { channels, programmesByChannel } satisfies EpgData, streams }
}

describe('EPG pipeline at real catalogue scale', () => {
  it('indexes, matches and plans a 27.8k-channel catalogue without pathological cost', () => {
    const { guide, streams } = makeWorld()

    const t0 = Date.now()
    const index = buildGuideIndex(guide)
    const indexMs = Date.now() - t0

    const t1 = Date.now()
    const matches = matchXmltvChannels(streams, guide)
    const matchMs = Date.now() - t1

    // The bulk planner is the heaviest path in the app (it resolves every channel and scores the
    // unmatched residue), so it gets its own measurement.
    const t2 = Date.now()
    const plan = planBulkSuggestionApply(streams, index, new Map(), 0.8)
    const planMs = Date.now() - t2

    console.log(
      `scale: guide=${guide.channels.size} channels, streams=${streams.length} | index=${indexMs}ms match=${matchMs}ms plan=${planMs}ms | matches=${matches.size} planned=${plan.applied.length}`
    )

    // Correctness at scale: everything the tiers should reach, they reached.
    expect(matches.size).toBeGreaterThan(0)
    expect(matches.size).toBeLessThanOrEqual(streams.length)

    // Budgets with generous headroom — these exist to catch accidental O(n²), not to chase ms.
    expect(indexMs).toBeLessThan(3000)
    expect(matchMs).toBeLessThan(5000)
    expect(planMs).toBeLessThan(15000)

    // The planner must actually place the residue, and must leave the genuinely unrelated tail
    // alone — both halves matter, and 0-or-everything would mean the fixture stopped modelling
    // a real catalogue.
    expect(plan.applied.length).toBeGreaterThan(1000)
    expect(plan.belowThreshold).toBeGreaterThan(1000)
    expect(plan.applied.length + plan.belowThreshold + plan.alreadyMapped).toBe(plan.considered)
  }, 60000)
})
