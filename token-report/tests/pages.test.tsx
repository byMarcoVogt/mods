import { expect, test } from 'claude-code/testing'

import { BAND, api, pane, setup } from './harness'

// The band and the Settings pane draw on desktop and terminal, empty and with a real ledger (requests,
// an agent): no draw failure, no NaN/undefined, and every drawing well under the 100k cap.
for (const surface of ['desktop', 'terminal'] as const) {
  for (const filled of [false, true]) {
    test(`band and settings draw (${surface}, ${filled ? 'with data' : 'empty'})`, { timeoutMs: 60000 }, async ($, on) => {
      const t = setup($, on)
      await $.session.start({ cwd: '/w', surface, isInteractive: true } as never)
      if (filled) {
        await t.step({ turnId: 't1', index: 0 }, api(0, 120_000, 'claude-opus-5-5'))
        await t.spawnAgent('tu1', 'Research the cache docs')
        await t.step({ turnId: 't1', index: 0, agentId: 'ag1', model: 'claude-haiku-5-5' }, api(0, 30_000, 'claude-haiku-5-5'), ['Read'])
        await t.step({ turnId: 't1', index: 1 }, api(120_000, 8_000, 'claude-opus-5-5'))
        await t.complete({ usage: api(120_000, 8_000, 'claude-opus-5-5') })
      }
      for (const drawing of [
        await $.ui.mount({ plugin: 'token-report', surface, ...BAND } as never),
        await $.ui.mount({ plugin: 'token-report', surface, ...pane(100) } as never),
      ]) {
        const drawn = JSON.stringify(await drawing.drawn())
        expect(drawn).not.toContain('failed to draw')
        expect(drawn).not.toMatch(/NaN|"undefined"/)
        expect(drawn.length).toBeLessThan(100000)
      }
    })
  }
}
