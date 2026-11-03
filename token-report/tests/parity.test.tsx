import { expect, test } from 'claude-code/testing'

import { BAND, api, pane, setup } from './harness'
import { PARITY } from './parity.fixture'

// What the band and the Settings pane draw in a few states, frozen: a change to the look shows up here.
const SETTINGS = { currency: 'eur', away: 'compact', keepWarm: '1h', contextTarget: 400_000, atTarget: 'remind', coldAsk: '0.5', billing: 'subscription' }
const STATES: Record<string, { tokens: number; target?: number; minutes: number }> = {
  fresh: { tokens: 0, minutes: 0 },
  warm: { tokens: 180_000, minutes: 3 },
  cold: { tokens: 180_000, minutes: 61 },
  threshold: { tokens: 180_000, target: 100_000, minutes: 1 },
}

// The reset time is local, so any time zone gives the same text
const local = (text: string) => text.replace(/\(\d\d:\d\d\)/g, '(HH:MM)')

async function draw($: any, on: any, name: string) {
  const st = STATES[name]!
  const t = setup($, on)
  t.store['settings'] = { ...SETTINGS, ...(st.target ? { contextTarget: st.target } : {}) }
  t.env.tokens = st.tokens || undefined
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as never)
  if (st.tokens) {
    await t.step({ turnId: 't1', index: 0 }, api(st.tokens - 8_000, 8_000, 'claude-opus-5-5'))
    await t.complete({ usage: api(st.tokens - 8_000, 8_000, 'claude-opus-5-5') })
  }
  for (let i = 0; i < st.minutes; i++) await t.clock.advance(60_000)
  const band = local(await t.drawn(await $.ui.mount({ plugin: 'token-report', surface: 'desktop', ...BAND } as never)))
  const ui = await $.ui.mount({ plugin: 'token-report', surface: 'desktop', ...pane(110) } as never)
  // Text, button labels, each dropdown's value and each card's words
  const selects = (await ui.findAll({ type: 'Select' })).map((n: { props: { value?: string } }) => '<' + (n.props.value ?? '') + '>')
  // Cards by their words, ⓘ by their tooltip text
  const cards = (await ui.findAll({ type: 'Svg' })).map((n: { props: { alt?: string; source?: string } }) =>
    '{' + (n.props.alt ?? '') + (/<title>([\s\S]*?)<\/title>/.exec(n.props.source ?? '')?.[1] ?? '') + '}')
  const settings = local(await t.drawn(ui)) + selects.join('') + cards.join('')
  return { band, settings }
}

for (const name of Object.keys(STATES)) {
  test('parity: ' + name, { timeoutMs: 60_000 }, async ($, on) => {
    const got = await draw($, on, name)
    const want = PARITY[name]
    expect(want).toBeDefined()
    expect(got.band).toBe(want!.band)
    expect(got.settings).toBe(want!.settings)
  })
}
