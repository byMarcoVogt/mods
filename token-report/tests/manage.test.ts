import { expect, test } from 'claude-code/testing'

import { api, setup } from './harness'

// Cache management and Context management
const MIN = 60_000
const SLOW = { timeoutMs: 30_000 }
const SUMMARY = [{ role: 'user' as const, text: 'summary', toolUses: [] }]

async function session($: any, on: any, settings: Record<string, unknown>, tokens: number) {
  const t = setup($, on)
  t.store['settings'] = settings
  t.env.tokens = tokens
  const compactions: string[] = []
  on('session.compact', async (_$: unknown, e: { trigger: string; instructions?: string }) => {
    compactions.push(e.trigger + (e.instructions ? ':' + e.instructions : ''))
    return { messages: SUMMARY, tokensBefore: t.env.tokens, tokensAfter: 20_000 }
  })
  on('turn.start', async (_$: unknown, e: unknown) => e as never)
  on('prompt.submit', async (_$: unknown, e: { text: string }) => ({ text: e.text }))
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as never)
  await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } } as never)
  await $.turn.start({ turnId: 't1', text: 'go' } as never)
  await t.step({}, api(tokens, 0, 'claude-opus-5-5'))
  await t.complete({ usage: api(tokens, 0, 'claude-opus-5-5') })
  return { t, compactions, advance: async (minutes: number) => { for (let i = 0; i < minutes; i++) await t.clock.advance(MIN) } }
}

test('Compact: once, 10 min before a 1 h cache goes cold', SLOW, async ($, on) => {
  const { compactions, advance } = await session($, on, { away: 'compact', atTarget: 'off', billing: 'subscription' }, 150_000)
  await advance(49)
  expect(compactions.length).toBe(0)
  await advance(3)
  expect(compactions.length).toBe(1)
  await advance(30)
  expect(compactions.length).toBe(1)
})

test('Compact: not below 50k', SLOW, async ($, on) => {
  const { compactions, advance } = await session($, on, { away: 'compact', atTarget: 'off', billing: 'subscription' }, 30_000)
  await advance(65)
  expect(compactions.length).toBe(0)
})

test('Compact: from Claude Code\'s idle threshold on, the mod leaves it to Claude Code', SLOW, async ($, on) => {
  const { compactions, advance } = await session($, on, { away: 'compact', atTarget: 'off', billing: 'subscription' }, 250_000)
  await advance(65)
  expect(compactions.length).toBe(0)
})

test('Keep full: nothing compacts while you are away', SLOW, async ($, on) => {
  const { compactions, advance } = await session($, on, { away: 'keep', atTarget: 'off', billing: 'subscription' }, 150_000)
  await advance(65)
  expect(compactions.length).toBe(0)
})

test('Compact keeps: the instructions go with the compaction the mod starts', SLOW, async ($, on) => {
  const { compactions, advance } = await session($, on, { away: 'compact', atTarget: 'off', billing: 'subscription', compactNote: 'keep the plan' }, 150_000)
  await advance(52)
  expect(compactions[0]).toContain('keep the plan')
})

test('Reminder: at the threshold, again only 100k further', SLOW, async ($, on) => {
  const { t } = await session($, on, { away: 'keep', atTarget: 'remind', contextTarget: 400_000 }, 410_000)
  const above = () => t.env.toasts.filter(x => x.includes('above your 400k threshold')).length
  expect(above()).toBe(1)
  t.env.tokens = 450_000
  await t.complete({ usage: api(450_000, 0, 'claude-opus-5-5') })
  expect(above()).toBe(1)
  t.env.tokens = 505_000
  await t.complete({ usage: api(505_000, 0, 'claude-opus-5-5') })
  expect(above()).toBe(2)
})

test('Compact at the threshold: compacts right after the turn and says so', SLOW, async ($, on) => {
  const { t, compactions } = await session($, on, { away: 'keep', atTarget: 'compact', contextTarget: 400_000 }, 410_000)
  await t.clock.advance(2_000)
  await t.clock.settle()
  expect(compactions.length).toBe(1)
  expect(t.env.toasts).toContain('Compacted 410k → 20k')
})
