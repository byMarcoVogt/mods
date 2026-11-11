import { expect, test } from 'claude-code/testing'

import { api, setup } from './harness'

// Found 2026-11-10: a compaction Claude Code refused while a turn ran showed "Compaction failed" and was
// never tried again; and a model switch on a warm cache answered 'ask', which the desktop app turns into
// a block. Now the compaction is queued for the turn's end, and the switch goes through with a price toast.
const SLOW = { timeoutMs: 30_000 }
const SUMMARY = [{ role: 'user' as const, text: 'summary', toolUses: [] }]

// A session over the 400k threshold with "Compact" at the threshold. `busy()` says whether a turn runs:
// while it does, Claude Code refuses the compaction
async function session($: any, on: any) {
  const t = setup($, on)
  t.store['settings'] = { away: 'keep', atTarget: 'compact', contextTarget: 400_000 }
  t.env.tokens = 410_000
  let isBusy = false
  const compactions: string[] = []
  on('session.compact', async (_$: unknown, e: { trigger: string }) => {
    if (isBusy) throw new Error('a turn is running')
    compactions.push(e.trigger)
    return { messages: SUMMARY, tokensBefore: t.env.tokens, tokensAfter: 20_000 }
  })
  on('turn.start', async (_$: unknown, e: unknown) => e as never)
  on('prompt.submit', async (_$: unknown, e: { text: string }) => ({ text: e.text }))
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as never)
  await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } } as never)
  await $.turn.start({ turnId: 't1', text: 'go' } as never)
  await t.step({}, api(410_000, 0, 'claude-opus-5-5'))
  await t.complete({ usage: api(410_000, 0, 'claude-opus-5-5') })
  return { t, compactions, busy: (b: boolean) => { isBusy = b } }
}

test('a compaction refused while a turn runs is queued, then runs after the turn', SLOW, async ($, on) => {
  const { t, compactions, busy } = await session($, on)
  // The next turn starts before the threshold's compaction comes due
  await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } } as never)
  await $.turn.start({ turnId: 't2', text: 'next' } as never)
  busy(true)
  await t.clock.advance(2_000)
  await t.clock.settle()
  expect(compactions.length).toBe(0)
  expect(t.env.toasts).toContain('Compaction queued: runs after this turn')
  expect(t.env.toasts.some(x => x.startsWith('Compaction failed'))).toBe(false)
  // The turn ends: the owed compaction runs at the next quiet moment
  busy(false)
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't2', usage: api(410_000, 0, 'claude-opus-5-5') })
  await t.clock.advance(20_000)
  await t.clock.settle()
  expect(compactions.length).toBe(1)
  expect(t.env.toasts).toContain('Compacted 410k → 20k')
})

test('a compaction refused between turns still says it failed', SLOW, async ($, on) => {
  const { t, compactions, busy } = await session($, on)
  busy(true)          // refused although no turn runs
  await t.clock.advance(2_000)
  await t.clock.settle()
  expect(compactions.length).toBe(0)
  expect(t.env.toasts.some(x => x.startsWith('Compaction failed'))).toBe(true)
  expect(t.env.toasts).not.toContain('Compaction queued: runs after this turn')
})

const SWITCH = {
  from_model: 'claude-opus-5-5', to_model: 'claude-fable-5-2', requested_model: 'fable', source: 'sdk',
  context_tokens: 93_000, prompt_cache_warm: true, cache_ttl: '1h', estimated_cache_write_usd: 0.97, pricing: 'catalog',
}

test('a model switch on a warm cache goes through, with the price in a toast', SLOW, async ($, on) => {
  const t = setup($, on)
  on('classic.PreModelSwitch', async () => ({}))
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as never)
  const r: any = await $.classic.PreModelSwitch(SWITCH as never)
  expect(r?.permissionDecision).not.toBe('ask')
  expect(r?.permissionDecision).not.toBe('deny')
  expect(t.env.toasts.some(x => x.startsWith('Model switch: re-caches 93k on fable-5-2'))).toBe(true)
})

test('a model switch on a cold cache: no toast', SLOW, async ($, on) => {
  const t = setup($, on)
  on('classic.PreModelSwitch', async () => ({}))
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as never)
  await $.classic.PreModelSwitch({ ...SWITCH, prompt_cache_warm: false } as never)
  expect(t.env.toasts.some(x => x.startsWith('Model switch'))).toBe(false)
})
