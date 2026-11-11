import { expect, mock, test } from 'claude-code/testing'

import { eventsIdle } from '../hooks/events'
import { api, setup } from './harness'

// v2 slice 1 (plan/v2-slice1-wakeups.md): turns nobody typed. "Turns nobody typed": count (default) ·
// act. Case A: compact after such a turn above the threshold. Case B: compact before one that wakes a
// cold cache. Never a dialog on such a turn; a `wake` line in the event log at its end.
const ON = { options: { eventLogFolder: '~/.claude/data-lake/token-report' } }
const MIN = 60_000
const SLOW = { timeoutMs: 60_000, ...ON }
const START = Date.UTC(2026, 10, 10, 9, 0, 0)
const FILE = 'C:/Users/Test/.claude/data-lake/token-report/events-2026-11.jsonl'
const SUMMARY = [{ role: 'user' as const, text: 'summary', toolUses: [] }]
const PEER = '<cross-session-message from="local_abc">Done: PR opened</cross-session-message>'

type Opts = { settings?: Record<string, unknown>; tokens?: number; first?: () => void; firstKind?: string }

async function world($: any, on: any, opts: Opts = {}) {
  // Answers before the harness's catch-all tool.call: the dialogs the mod opens
  opts.first?.()
  const asked: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, async (_$: unknown, e: any) => {
    const q = e.questions[0].question
    asked.push(q)
    return { result: { questions: e.questions, answers: { [q]: 'Not now' } } }
  })
  const t = setup($, on, START)
  mock.env(on, { USERPROFILE: 'C:\\Users\\Test' })
  const files = new Map<string, string>()
  const slash = (p: string) => p.split(String.fromCharCode(92)).join('/')
  on('fs.exists', async (_$: unknown, e: { path: string }) => ({ value: files.has(slash(e.path)) }))
  on('fs.read', async (_$: unknown, e: { path: string }) => {
    const text = files.get(slash(e.path))
    if (text === undefined) throw new Error('ENOENT ' + e.path)
    return { value: text }
  })
  on('fs.write', async (_$: unknown, e: { path: string; text: string }) => { files.set(slash(e.path), e.text); return { value: undefined } })
  // The mod's own compactions (trigger plugin) apart from Claude Code's
  const compactions: string[] = []
  on('session.compact', async (_$: unknown, e: { trigger: string }) => {
    compactions.push(e.trigger)
    return { messages: SUMMARY, tokensBefore: t.env.tokens, tokensAfter: 30_000, usage: api(0, 30_000, 'claude-opus-5-5', 250_000, 3_000) }
  })
  on('turn.start', async (_$: unknown, e: unknown) => e as never)
  // Every prompt that entered, with what the mod sent it as
  const sent: { text: string; origin: any; asUser?: boolean }[] = []
  on('prompt.submit', async (_$: unknown, e: any) => {
    sent.push({ text: e.text, origin: e.origin, asUser: e.origin?.asUser })
    return { text: e.text }
  })
  t.store['settings'] = { billing: 'subscription', away: 'keep', coldAsk: '0.5', contextTarget: 400_000, atTarget: 'remind', ...opts.settings }
  t.env.tokens = opts.tokens ?? 180_000
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as never)
  let n = 0
  // One main turn from a prompt of this origin; `requests` false: the turn's first request is skipped
  const turn = async (kind: string, text = 'go', extra: Record<string, unknown> = {}) => {
    const id = 't' + ++n
    await $.prompt.submit({ text, wait: false, origin: { kind }, ...extra } as never)
    await $.turn.start({ turnId: id, text } as never)
    const tok = t.env.tokens ?? 0
    await t.step({ turnId: id }, api(tok, 0, 'claude-opus-5-5'))
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: id, usage: api(tok, 0, 'claude-opus-5-5') })
    await eventsIdle()
  }
  const settle = async (ms = 3_000) => { await t.clock.advance(ms); await t.clock.settle(); await eventsIdle() }
  const advance = async (minutes: number) => { for (let i = 0; i < minutes; i++) await t.clock.advance(MIN) }
  const rows = (kind?: string) =>
    (files.get(FILE) || '').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>).filter(r => !kind || r.kind === kind)
  // A first turn of a person's, so the cache has a clock
  await turn(opts.firstKind ?? 'composer')
  return { t, files, asked, compactions, sent, turn, settle, advance, rows }
}

test('ask after a turn nobody typed above the threshold: a toast, no dialog; a person\'s turn still asks', SLOW, async ($, on) => {
  const w = await world($, on, { settings: { atTarget: 'ask' } })
  w.t.env.tokens = 410_000
  await w.turn('peer', PEER)
  await w.settle()
  expect(w.asked.length).toBe(0)
  expect(w.t.env.toasts.filter(x => x.includes('above your 400k threshold')).length).toBe(1)
  // A person's turn, a further 100k on: the dialog as before
  w.t.env.tokens = 520_000
  await w.turn('composer')
  await w.settle()
  expect(w.asked.length).toBe(1)
})

test('act, warm, above the threshold, peer: one compaction after the turn; wake action compact_after', SLOW, async ($, on) => {
  const w = await world($, on, { settings: { unattended: 'act' } })
  w.t.env.tokens = 410_000
  await w.turn('peer', PEER)
  await w.settle()
  expect(w.compactions.filter(c => c !== 'precompute').length).toBe(1)
  expect(w.t.env.toasts).toContain('Compacted 410k → 30k (turn nobody typed)')
  expect(w.rows('wake')).toMatchObject([{ origin: 'peer', cold: false, reload_usd: null, above_target: true, setting: 'act', action: 'compact_after', would: 'compact_after', model: 'claude-opus-5-5' }])
  const c = w.rows('compact')
  expect(c).toMatchObject([{ cause: 'wake', by: 'token_report', automatic: true }])
  expect(typeof c[0]!.usd).toBe('number')
})

test('act compacts above the threshold even when the threshold says Reminder or Ask; Off stays off', SLOW, async ($, on) => {
  const w = await world($, on, { settings: { unattended: 'act', atTarget: 'ask' } })
  w.t.env.tokens = 410_000
  await w.turn('task-notification')
  await w.settle()
  expect(w.compactions.length).toBe(1)
  expect(w.asked.length).toBe(0)
})

test('count, warm, above the threshold: no compaction; wake action none, would compact_after', SLOW, async ($, on) => {
  const w = await world($, on)
  w.t.env.tokens = 410_000
  await w.turn('peer', PEER)
  await w.settle()
  expect(w.compactions.length).toBe(0)
  expect(w.rows('wake')).toMatchObject([{ origin: 'peer', setting: 'count', action: 'none', would: 'compact_after', above_target: true }])
})

test('act, cold, peer, a summary kept: the mod compacts nothing itself; wake action use_summary', SLOW, async ($, on) => {
  // Above Claude Code's idle threshold (200k): its idle summary is written ahead, the mod lets it be
  const w = await world($, on, { settings: { unattended: 'act', away: 'compact' }, tokens: 250_000 })
  await w.advance(55)
  await $.session.compact({ trigger: 'precompute', messages: SUMMARY } as never)
  await w.advance(7)
  await $.prompt.submit({ text: PEER, wait: false, origin: { kind: 'peer' } } as never)
  // Claude Code puts the kept summary in with the message
  await $.session.compact({ trigger: 'auto', messages: SUMMARY } as never)
  w.t.env.tokens = 32_000
  await $.turn.start({ turnId: 'tw', text: PEER } as never)
  await w.t.step({ turnId: 'tw' }, api(0, 32_000, 'claude-opus-5-5'))
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 'tw', usage: api(0, 32_000, 'claude-opus-5-5') })
  await w.settle()
  expect(w.compactions.filter(c => c !== 'precompute' && c !== 'auto')).toEqual([])
  expect(w.rows('wake')).toMatchObject([{ origin: 'peer', cold: true, setting: 'act', action: 'use_summary', would: 'use_summary' }])
  expect(w.rows('compact')).toMatchObject([{ by: 'claude_code', trigger: 'auto', cause: null }])
})

test('act, cold, no summary: compacts first, the text arrives again framed with its wrapper; action compact_first', SLOW, async ($, on) => {
  const w = await world($, on, { settings: { unattended: 'act' } })
  await w.advance(61)
  const before = w.sent.length
  await w.turn('peer', PEER + '<system-reminder>app context</system-reminder>')
  await w.settle()
  // The wake-up's first request was skipped: the ledger holds only the person's turn
  expect((w.t.store['ledger:live'] as { ledger: { requests: unknown[] } }).ledger.requests.length).toBe(1)
  expect(w.compactions.length).toBe(1)
  const again = w.sent.slice(before + 1)
  expect(again.length).toBe(1)
  expect(again[0]!.text).toBe(PEER)
  expect(again[0]!.asUser).toBeUndefined()
  expect(again[0]!.origin).toMatchObject({ kind: 'plugin' })
  expect(w.rows('wake')).toMatchObject([{ origin: 'peer', cold: true, reload_usd: 1.44, setting: 'act', action: 'compact_first', would: 'compact_first' }])
  expect(w.rows('compact')).toMatchObject([{ cause: 'wake' }])
  // The framed text's own turn continues the wake-up: no second wake line
  await w.turn('plugin', PEER, { origin: { kind: 'plugin', name: 'token-report' } })
  expect(w.rows('wake').length).toBe(1)
})

test('act, cold, a prompt with attachments: sent as is; action sent_cold', SLOW, async ($, on) => {
  const w = await world($, on, { settings: { unattended: 'act' } })
  await w.advance(61)
  await w.turn('task-notification', 'see image', { attachments: [{ type: 'image', mediaType: 'image/png' }] })
  await w.settle()
  expect(w.compactions.length).toBe(0)
  expect((w.t.store['ledger:live'] as { ledger: { requests: unknown[] } }).ledger.requests.length).toBe(2)
  expect(w.rows('wake')).toMatchObject([{ origin: 'task-notification', cold: true, action: 'sent_cold', would: 'sent_cold' }])
})

test('coldAsk off and atTarget off: nothing happens, would none', SLOW, async ($, on) => {
  const w = await world($, on, { settings: { unattended: 'act', coldAsk: 'off', atTarget: 'off' } })
  w.t.env.tokens = 410_000
  await w.advance(61)
  await w.turn('peer', PEER)
  await w.settle()
  expect(w.compactions.length).toBe(0)
  expect(w.rows('wake')).toMatchObject([{ cold: true, above_target: true, would: 'none', action: 'sent_cold' }])
})

test('no dialog on any turn nobody typed, across the settings', { ...SLOW, timeoutMs: 240_000 }, async ($, on) => {
  const w = await world($, on)
  let i = 0
  for (const unattended of ['count', 'act']) for (const atTarget of ['off', 'remind', 'ask', 'compact']) for (const coldAsk of ['off', '0.5', 'any']) {
    w.t.store['settings'] = { billing: 'subscription', away: 'keep', contextTarget: 400_000, unattended, atTarget, coldAsk }
    // Each combination on a new session id would cost a session each: the store is read afresh per turn
    // through Settings' Global scope, so the same session runs every combination
    await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as never)
    // Warm and above, then cold and above
    w.t.env.tokens = 410_000 + (i++ % 3) * 100_000
    await w.turn('scheduled-trigger')
    await w.settle()
    await w.advance(61)
    await w.turn('peer', PEER)
    await w.settle()
  }
  expect(w.asked).toEqual([])
})

test('event log off: no file is written', { timeoutMs: 60_000 }, async ($, on) => {
  const w = await world($, on, { settings: { unattended: 'act' } })
  w.t.env.tokens = 410_000
  await w.turn('peer', PEER)
  await w.settle()
  expect(w.files.size).toBe(0)
})

test('the Cache Warmer\'s pause moves only with a person\'s turn', SLOW, async ($, on) => {
  const w = await world($, on)
  const pauseStart = () => (w.t.store['extra:live'] as { lastPromptAt: number }).lastPromptAt
  const first = pauseStart()
  expect(first).toBe(START)
  await w.advance(10)
  await w.turn('peer', PEER)
  expect(pauseStart()).toBe(first)
  await w.advance(10)
  await w.turn('composer')
  expect(pauseStart()).toBe(START + 20 * MIN)
})

test('a started child treats its brief as a turn nobody typed (get_session self); a failed call: origins alone', SLOW, async ($, on) => {
  const w = await world($, on, {
    settings: { atTarget: 'ask', contextTarget: 100_000 }, firstKind: 'sdk',
    first: () => on('tool.call', { tool: 'mcp__ccd_session_mgmt__get_session' }, async () => ({ result: JSON.stringify({ session: { id: 'local_x', parentSessionId: 'local_p', detached: false } }) })),
  })
  await w.settle()
  expect(w.asked.length).toBe(0)
  expect(w.rows('wake')).toMatchObject([{ origin: 'child_brief', setting: 'count', above_target: true, would: 'compact_after' }])
})

test('a session that is no child: its sdk first turn counts as a person turn', SLOW, async ($, on) => {
  const w = await world($, on, { settings: { atTarget: 'ask', contextTarget: 100_000 }, firstKind: 'sdk' })
  await w.settle()
  expect(w.asked.length).toBe(1)
  expect(w.rows('wake')).toEqual([])
})
