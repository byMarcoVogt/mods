import { expect, test } from 'claude-code/testing'

import { api, setup } from './harness'

// A turn that resumes mid-way on a cold cache (your answer to a question after a day, a long tool): its
// next main request asks first, as your own message does. Found 2026-11-08: an AskUserQuestion answered
// 24 h later rewrote 306k tokens with no question.
const MIN = 60_000
const SLOW = { timeoutMs: 30_000 }

async function begin($: any, on: any, answer = 'Cancel', tokens = 180_000) {
  // The dialog's answer, registered before the harness's catch-all tool.call so it is the one that answers
  // 'hold': the question stays open until `release` (a question the model asked, waiting on you)
  const asked: string[] = []
  let release: () => void = () => {}
  on('tool.call', { tool: 'AskUserQuestion' }, async (_$: unknown, e: any) => {
    const q = e.questions[0].question
    asked.push(q)
    if (answer === 'hold') await new Promise<void>(r => { release = r })
    return { result: { questions: e.questions, answers: { [q]: answer } } }
  })
  const logs: string[] = []
  on('ui.log', async (_$: unknown, e: { text: string }) => { logs.push(e.text); return { value: undefined } })
  on('session.surfaces', async () => ({ value: [{ kind: 'desktop' }] }))
  const t = setup($, on)
  t.store['settings'] = { coldAsk: '0.5', billing: 'subscription', away: 'keep' }
  t.env.tokens = tokens
  on('turn.start', async (_$: unknown, e: unknown) => e as never)
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as never)
  await $.turn.start({ turnId: 't1', text: 'go' } as never)
  // The turn's first request: the cache clock starts
  await t.step({ index: 0 }, api(100, tokens, 'claude-opus-5-5'), ['AskUserQuestion'])
  const wait = async (minutes: number) => { for (let m = 0; m < minutes; m++) await t.clock.advance(MIN) }
  // Requests the ledger counted once the turn has ended (each one that was sent)
  const sent = async () => {
    await t.complete({})
    return (t.store['ledger:live'] as { ledger: { requests: unknown[] } }).ledger.requests.length
  }
  return { ...t, asked, logs, wait, sent, release: () => release() }
}

test('resumed mid-turn after the cache went cold: asks, Cancel makes no request', SLOW, async ($, on) => {
  const t = await begin($, on, 'Cancel')
  await t.wait(65)
  await t.step({ index: 1 }, api(0, 180_000, 'claude-opus-5-5'))
  expect(t.asked.length).toBe(1)
  expect(t.asked[0]).toMatch(/went cold while it waited/)
  expect(t.logs.join(' ')).toMatch(/stopped before going on/)
  expect(await t.sent()).toBe(1)
})

test('resumed mid-turn after the cache went cold: Send anyway sends', SLOW, async ($, on) => {
  const t = await begin($, on, 'Send anyway')
  await t.wait(65)
  await t.step({ index: 1 }, api(0, 180_000, 'claude-opus-5-5'))
  expect(t.asked.length).toBe(1)
  expect(await t.sent()).toBe(2)
})

test('resumed mid-turn within the cache lifetime: no question', SLOW, async ($, on) => {
  const t = await begin($, on)
  await t.wait(30)
  await t.step({ index: 1 }, api(180_000, 100, 'claude-opus-5-5'))
  expect(t.asked.length).toBe(0)
  expect(await t.sent()).toBe(2)
})

test('a subagent request after the main cache went cold: no question', SLOW, async ($, on) => {
  const t = await begin($, on)
  await t.wait(65)
  await t.step({ index: 1, agentId: 'ag1' }, api(0, 20_000, 'claude-haiku-5-5'))
  expect(t.asked.length).toBe(0)
  expect(await t.sent()).toBe(2)
})

test('resumed mid-turn cold, rewrite below the Settings amount: no question', SLOW, async ($, on) => {
  const t = await begin($, on, 'Cancel', 10_000)
  await t.wait(65)
  await t.step({ index: 1 }, api(0, 10_000, 'claude-opus-5-5'))
  expect(t.asked.length).toBe(0)
  expect(await t.sent()).toBe(2)
})

test('a question waiting on you: the cache pop-up still comes, nothing compacts', SLOW, async ($, on) => {
  const t = await begin($, on, 'hold')
  await t.wait(50)
  // The model's question stays open while the clock runs past the warning time (a held hook is let go
  // after 10 s real time, so it opens late)
  const pending = $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 'q1', questions: [{ question: 'Which?', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }] })
  await t.wait(7)
  expect(t.env.toasts.some(x => /^Cache: \d+m \(a question is waiting/.test(x))).toBe(true)
  expect(t.env.toasts.some(x => /Compact/.test(x))).toBe(false)
  t.release()
  await pending
})

test('no question open: the turn stays quiet on the clock, as before', SLOW, async ($, on) => {
  const t = await begin($, on)
  await t.wait(57)
  expect(t.env.toasts.some(x => /^Cache: /.test(x))).toBe(false)
})
