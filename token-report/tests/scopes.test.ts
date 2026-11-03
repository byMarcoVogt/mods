import { expect, test } from 'claude-code/testing'

import { api, setup } from './harness'

// Settings precedence (Global < Project < Session, each scope checked on its own) and one compaction
// per crossing, whichever of its callers comes first
const MIN = 60_000
const SLOW = { timeoutMs: 30_000 }
const SUMMARY = [{ role: 'user' as const, text: 'summary', toolUses: [] }]

async function session($: any, on: any, global: Record<string, unknown>, project: unknown, tokens: number) {
  const t = setup($, on)
  t.store['settings'] = global
  t.env.tokens = tokens
  const compactions: string[] = []
  on('session.compact', async (_$: unknown, e: { trigger: string }) => {
    compactions.push(e.trigger)
    return { messages: SUMMARY, tokensBefore: t.env.tokens, tokensAfter: 20_000 }
  })
  on('session.cwd', async () => ({ value: '/w' }))
  on('fs.read', async (_$: unknown, e: { path: string }) => {
    // The engine hands the path on resolved (on Windows `C:\w\...`)
    if (project !== undefined && /[\\/]w[\\/]\.token-report[\\/]settings\.json$/.test(e.path)) return { value: JSON.stringify(project) }
    throw new Error('ENOENT')
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

test('a bad Project value falls back to Global, not to the default', SLOW, async ($, on) => {
  // Global says Compact, the project file has a typo. The default (Keep full) would never compact.
  const { compactions, advance } = await session($, on, { away: 'compact', atTarget: 'off', billing: 'subscription' }, { away: 'typo' }, 150_000)
  await advance(52)
  expect(compactions.length).toBe(1)
})

test('a valid Project value wins over Global', SLOW, async ($, on) => {
  const { compactions, advance } = await session($, on, { away: 'keep', atTarget: 'off', billing: 'subscription' }, { away: 'compact' }, 150_000)
  await advance(52)
  expect(compactions.length).toBe(1)
})

test('a project file that is not an object is ignored, and the band still draws', SLOW, async ($, on) => {
  const { compactions, advance } = await session($, on, { away: 'keep', atTarget: 'off', billing: 'subscription' }, null, 150_000)
  await advance(65)
  expect(compactions.length).toBe(0)
})

test('Compact at the threshold: once, though the tick and the turn both could start it', SLOW, async ($, on) => {
  const { compactions, advance } = await session($, on, { away: 'keep', atTarget: 'compact', contextTarget: 400_000 }, undefined, 410_000)
  await advance(2)
  expect(compactions.length).toBe(1)
})
