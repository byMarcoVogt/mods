import { expect, test } from 'claude-code/testing'

import { api, setup } from './harness'

// The warmer's pause: a pop-up ten minutes in (not at the first ping), and a turn no person started
// (a schedule, a notification) keeps the pause going instead of ending it.
const MIN = 60_000
const SLOW = { timeoutMs: 30_000 }

async function pause($: any, on: any, isAnswered = true) {
  const t = setup($, on)
  t.store['settings'] = { away: 'warm-compact', keepWarm: '1h' }
  const pings = { n: 0 }
  on('turn.start', async (_$: unknown, e: unknown) => e as never)
  on('prompt.submit', async (_$: unknown, e: { text: string }) => ({ text: e.text }))
  on('model.fork', async () => {
    pings.n++
    return { value: isAnswered ? { isAnswered, text: 'ok', usage: api(180_000, 0, 'claude-opus-5-5') } : { isAnswered, reason: 'api-error', usage: api(0, 0, 'claude-opus-5-5', 0, 0) } }
  })
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as never)
  // A message, its request, its end
  const turn = async (kind: string) => {
    await $.prompt.submit({ text: 'go', wait: false, origin: { kind } } as never)
    await $.turn.start({ turnId: 't1', text: 'go' } as never)
    await t.step({}, api(180_000, 0, 'claude-opus-5-5'))
    await t.complete({})
  }
  await turn('sdk')
  return { t, turn, pings, advance: async (minutes: number) => { for (let i = 0; i < minutes; i++) await t.clock.advance(MIN) } }
}

test('the warmer pops up ten minutes into a pause, once', SLOW, async ($, on) => {
  const { t, advance } = await pause($, on)
  await advance(9)
  expect(t.env.toasts).not.toContain('Cache Warmer')
  await advance(2)
  await advance(30)
  expect(t.env.toasts.filter(x => x === 'Cache Warmer').length).toBe(1)
})

// The 1 h warmer from your message at 0 is over at 60; one restarted at 30 would ping before 90
for (const [origin, isRestarted] of [['scheduled-trigger', false], ['sdk', true]] as const) {
  test('a turn from ' + origin + (isRestarted ? ' ends' : ' keeps') + ' the pause', SLOW, async ($, on) => {
    const p = await pause($, on)
    await p.advance(30)
    await p.turn(origin)
    await p.advance(58)
    expect(p.pings.n).toBe(isRestarted ? 1 : 0)
  })
}

// A ping the API refuses is tried again a few times, a minute apart, not on every 15 s tick
test('a failed ping is retried a minute apart', SLOW, async ($, on) => {
  const p = await pause($, on, false)
  await p.advance(62)
  expect(p.pings.n).toBeLessThanOrEqual(4)
})
