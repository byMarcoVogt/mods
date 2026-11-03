import { expect, test } from 'claude-code/testing'

import { setup } from './harness'

// Claude Code's idle compaction (`precompute`): vetoed under "Keep full" and "Cache Warmer, then keep full" (When
// you're away); passed through otherwise, also while the warmer runs (the summary is kept; the mod
// decides when it goes in).
const MESSAGES = [{ role: 'user' as const, text: 'summary', toolUses: [] }]
const precompute = ($: any) => $.session.compact({ trigger: 'precompute', messages: MESSAGES })
const HOUR = 3_600_000
// An hour of 15 s ticks takes seconds on a busy machine
const SLOW = { timeoutMs: 30_000 }

for (const [name, saved, laterMs, isSkipped] of [
  ['Compact: runs', { away: 'compact' }, HOUR, false],
  ['Keep full: vetoed', { away: 'keep' }, HOUR, true],
  ['Cache Warmer, then keep full: vetoed', { away: 'warm-keep', keepWarm: '2h' }, HOUR, true],
  // Older names still read right
  ['old Off: vetoed', { away: 'off' }, HOUR, true],
  // It may write while the warmer runs (a veto would lose it for the pause); it is only kept
  ['Cache Warmer 2 h then compact, 1 h later: writes its summary ahead', { away: 'warm-compact', keepWarm: '2h' }, HOUR, false],
  ['Cache Warmer 1 h then compact, 2 h later: runs', { away: 'warm-compact', keepWarm: '1h' }, 2 * HOUR, false],
] as const) {
  test('idle compaction ' + name, SLOW, async ($, on) => {
    const t = setup($, on)
    t.store['settings'] = saved
    on('session.compact', async () => ({ messages: MESSAGES }))
    on('turn.start', async (_$: unknown, e: unknown) => e as never)
    await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as never)
    // Your last message, then the pause
    await $.turn.start({ turnId: 't1' } as never)
    await t.complete({})
    // A minute at a time: the mod's 15 s tick runs throughout
    for (let ms = 0; ms < laterMs; ms += 60_000) await t.clock.advance(60_000)
    const r = (await precompute($)) as { skip?: string }
    expect(!!r?.skip).toBe(isSkipped)
  })
}
