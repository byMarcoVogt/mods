import { expect, test } from 'claude-code/testing'

import { BAND, api, setup } from './harness'

// A narrow band stays on one line as long as it can: first the extras go, then the labels, then Weekly.
// Only then do whole segments wrap, and never with a bar at a line's start or end.
const SETTINGS = { billing: 'subscription', currency: 'eur', contextTarget: 400_000, atTarget: 'remind' }

async function drawAt($: any, on: any, columns: number) {
  const t = setup($, on)
  t.store['settings'] = SETTINGS
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as never)
  for (const [i, ctx] of [150_000, 180_000].entries()) {
    t.env.tokens = ctx
    await t.step({ turnId: 't' + i, index: 0 }, api(ctx - 8_000, 8_000, 'claude-opus-5-5'))
    await t.complete({ turnId: 't' + i, usage: api(ctx - 8_000, 8_000, 'claude-opus-5-5') })
  }
  const ui = await $.ui.mount({ plugin: 'token-report', surface: 'desktop', ...BAND, props: { ...BAND.props, bodyColumns: columns } } as never)
  return { text: await t.drawn(ui) }
}

test('wide: everything, on one line', { timeoutMs: 60_000 }, async ($, on) => {
  const { text } = await drawAt($, on, 200)
  expect(text).toContain('Context: 180k (↑30k)')
  expect(text).toContain('Weekly: 81%')
})

test('narrower: the extras go first', { timeoutMs: 60_000 }, async ($, on) => {
  const { text } = await drawAt($, on, 100)
  expect(text).toContain('Context: 180k')
  expect(text).not.toContain('(↑')
  expect(text).not.toMatch(/\(\d\d:\d\d\)/)
})

test('narrower still: then the labels', { timeoutMs: 60_000 }, async ($, on) => {
  const { text } = await drawAt($, on, 70)
  expect(text).not.toContain('Context:')
  expect(text).toContain('81%')
})

test('very narrow: then Weekly', { timeoutMs: 60_000 }, async ($, on) => {
  const { text } = await drawAt($, on, 58)
  expect(text).not.toContain('81%')
  expect(text).toContain('180k')
})

test('too narrow even so: whole segments wrap, no bar at a line edge', { timeoutMs: 60_000 }, async ($, on) => {
  const { text } = await drawAt($, on, 36)
  expect(text).toContain('180k')
  expect(text).not.toMatch(/^ ?│|│ ?$/)
})
