import { expect, mock, test } from 'claude-code/testing'

import { eventsIdle, limitRows, planOf } from '../hooks/events'
import { BAND, api, setup } from './harness'

// The event log (BUILD.md § Event log): rows in <eventLogFolder>/events-YYYY-MM.jsonl, off without the option
const ON = { options: { eventLogFolder: '~/.claude/data-lake/token-report' } }
const MIN = 60_000
const SLOW = { timeoutMs: 30_000, ...ON }
const START = Date.UTC(2026, 10, 10, 9, 0, 0)
const FILE = 'C:/Users/Test/.claude/data-lake/token-report/events-2026-11.jsonl'
const RESET = '2026-11-10T12:00:00.000Z'
const lim = (kind: string, percentUsed: number, resetsAt: string | null = RESET) => ({ kind, percentUsed, ...(resetsAt ? { resetsAt } : {}) })

async function world($: any, on: any, opts: { failWrites?: boolean; unreadable?: string; settings?: Record<string, unknown>; hooks?: () => void; first?: () => void } = {}) {
  // `first`: hooks that must answer before the harness's catch-all ones (tool.call)
  opts.first?.()
  const t = setup($, on, START)
  mock.env(on, { USERPROFILE: 'C:\\Users\\Test' })
  const files = new Map<string, string>()
  const slash = (p: string) => p.split(String.fromCharCode(92)).join('/')
  on('fs.exists', async (_$: unknown, e: { path: string }) => ({ value: files.has(slash(e.path)) || slash(e.path) === opts.unreadable }))
  on('fs.read', async (_$: unknown, e: { path: string }) => {
    const text = files.get(slash(e.path))
    if (text === undefined) throw new Error('ENOENT ' + e.path)
    return { value: text }
  })
  on('fs.write', async (_$: unknown, e: { path: string; text: string }) => {
    if (opts.failWrites) throw new Error('EACCES ' + e.path)
    files.set(slash(e.path), e.text)
    return { value: undefined }
  })
  on('turn.start', async (_$: unknown, e: unknown) => e as never)
  on('prompt.submit', async (_$: unknown, e: { text: string }) => ({ text: e.text }))
  if (opts.settings) t.store['settings'] = opts.settings
  opts.hooks?.()
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as never)
  const turn = async (limits?: unknown[]) => {
    if (limits) t.env.limits = limits
    await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'sdk' } } as never)
    await $.turn.start({ turnId: 't1', text: 'go' } as never)
    await t.step({}, api(180_000, 0, 'claude-opus-5-5'))
    await t.complete({ usage: api(180_000, 0, 'claude-opus-5-5') })
    await eventsIdle()
  }
  const rows = (kind?: string) =>
    (files.get(FILE) || '').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>).filter(r => !kind || r.kind === kind)
  return { t, files, turn, rows, advance: async (minutes: number) => { for (let i = 0; i < minutes; i++) await t.clock.advance(MIN) } }
}

test('limitRows: a row per limit that moved, any kind, none for one that did not', () => {
  const first = limitRows([lim('five_hour', 40), lim('seven_day', 81.5), lim('seven_day_fable', 12, null)], {})
  expect(first.rows).toEqual([
    { limit: 'five_hour', percent_used: 40, resets_at: RESET, source: 'engine' },
    { limit: 'seven_day', percent_used: 81.5, resets_at: RESET, source: 'engine' },
    { limit: 'seven_day_fable', percent_used: 12, resets_at: null, source: 'engine' },
  ])
  const same = limitRows([lim('five_hour', 40), lim('seven_day', 81.5), lim('seven_day_fable', 12, null)], first.seen)
  expect(same.rows).toEqual([])
  const moved = limitRows([lim('five_hour', 41), lim('seven_day', 81.5), { kind: 'broken' }, null], same.seen)
  expect(moved.rows).toEqual([{ limit: 'five_hour', percent_used: 41, resets_at: RESET, source: 'engine' }])
  expect(limitRows(undefined, {}).rows).toEqual([])
})

const win = (label: string, percentUsed: number, resetsAt = '2026-11-14T03:00:00.034Z') => ({ label, percentUsed, resetsAt, resetsIn: '3d 12h' })
const card = (windows: unknown[], status = 'ok') => ({ plan: { status, plan: 'Max', windows }, context: { status: 'ok' } })

test('the app\'s usage card: any window by its label, apart from the engine\'s, a reset time that wobbles by ms is the same', () => {
  const first = limitRows([win('5-hour limit', 55), win('Weekly · Fable', 59)], { five_hour: '40|x' }, 'app')
  expect(first.rows).toEqual([
    { limit: '5-hour limit', percent_used: 55, resets_at: '2026-11-14T03:00:00.000Z', source: 'app' },
    { limit: 'Weekly · Fable', percent_used: 59, resets_at: '2026-11-14T03:00:00.000Z', source: 'app' },
  ])
  expect(first.seen.five_hour).toBe('40|x')
  expect(limitRows([win('5-hour limit', 55, '2026-11-14T03:00:00.035Z'), win('Weekly · Fable', 59)], first.seen, 'app').rows).toEqual([])
  // An early reset: the percent falls, the reset time jumps; a window that is new appears by itself
  const reset = limitRows([win('Weekly · Fable', 0, '2026-11-17T09:00:00.000Z'), win('Weekly · Sonnet', 3)], first.seen, 'app')
  expect(reset.rows.map(r => [r.limit, r.percent_used, r.resets_at])).toEqual([['Weekly · Fable', 0, '2026-11-17T09:00:00.000Z'], ['Weekly · Sonnet', 3, '2026-11-14T03:00:00.000Z']])
})

test('planOf: the plan from a tool answer as an object or as JSON text; nothing from a deny or an error', () => {
  expect(planOf({ result: card([win('a', 1)]) })?.windows.length).toBe(1)
  expect(planOf({ result: 'x', text: JSON.stringify(card([], 'unavailable')) })).toEqual({ status: 'unavailable', windows: [] })
  expect(planOf({ deny: 'no rule allows it' })).toBe(null)
  expect(planOf({ isError: true, text: JSON.stringify(card([])) })).toBe(null)
  expect(planOf({ result: 'done' })).toBe(null)
  expect(planOf(undefined)).toBe(null)
})

for (const [name, answer, calls, rows] of [
  ['answers', () => ({ result: card([win('5-hour limit', 55), win('Weekly · all models', 58), win('Weekly · Fable', 59)]) }), 3, 3],
  ['is denied', () => ({ deny: 'no rule allows it' }), 1, 0],
  ['is missing', () => { throw new Error('no tool has that name') }, 1, 0],
] as const) {
  test('the app\'s usage tool ' + name + ': ' + rows + ' rows, asked ' + calls + ' time(s) in three turns', ON, async ($, on) => {
    let asked = 0
    const w = await world($, on, {
      first: () => on('tool.call', { tool: 'mcp__ccd_session_mgmt__get_usage' }, async () => { asked++; return answer() as never }),
    })
    for (let i = 0; i < 3; i++) await w.turn([lim('five_hour', 40)])
    await new Promise(r => setTimeout(r, 20))
    await eventsIdle()
    expect(asked).toBe(calls)
    expect(w.rows('limit').filter(r => r.source === 'app').map(r => r.limit)).toEqual(rows ? ['5-hour limit', 'Weekly · all models', 'Weekly · Fable'] : [])
    expect(w.rows('limit').filter(r => r.source === 'engine').length).toBe(1)
    expect(w.t.env.toasts).toEqual([])
  })
}

test('off by default: nothing is read or written, the band still draws', async ($, on) => {
  const w = await world($, on)
  await w.turn([lim('five_hour', 40)])
  await w.turn([lim('five_hour', 55)])
  expect(w.files.size).toBe(0)
  expect(w.t.env.toasts).toEqual([])
  expect(await w.t.drawn(await $.ui.mount({ plugin: 'token-report', surface: 'desktop', ...BAND } as never))).toContain('Context')
})

test('a folder given in full is used as it is', { options: { eventLogFolder: 'D:\\logs\\tr\\' } }, async ($, on) => {
  const w = await world($, on)
  await w.turn([lim('five_hour', 40)])
  expect([...w.files.keys()]).toEqual(['D:/logs/tr/events-2026-11.jsonl'])
})

test('a turn writes session_start once and one limit row per limit that changed', ON, async ($, on) => {
  const w = await world($, on)
  await w.turn([lim('five_hour', 40), lim('seven_day', 81)])
  expect(w.rows('session_start')).toEqual([{
    ts: '2026-11-10T09:00:00.000Z', session: 'live', kind: 'session_start',
    model: 'claude-opus-5-5', billing: 'subscription', billing_setting: 'auto', cache_ttl_min: 60, mod_version: '',
    // v2 slice 3: who this session is in the desktop app (none here: no get_session answer), and its profile
    local_id: null, parent: null, profile: 'auto',
  }])
  expect(w.rows('limit').map(r => [r.limit, r.percent_used, r.resets_at])).toEqual([['five_hour', 40, RESET], ['seven_day', 81, RESET]])
  // Nothing moved: no new row
  await w.turn()
  expect(w.rows().length).toBe(3)
  // One limit moved, and a kind not seen before arrives
  await w.turn([lim('five_hour', 42), lim('seven_day', 81), lim('seven_day_fable', 7)])
  expect(w.rows('limit').slice(2).map(r => [r.limit, r.percent_used])).toEqual([['five_hour', 42], ['seven_day_fable', 7]])
  expect(w.rows('session_start').length).toBe(1)
  // Every row: time, session, kind first; flat values only
  for (const r of w.rows()) {
    expect(Object.keys(r).slice(0, 3)).toEqual(['ts', 'session', 'kind'])
    for (const v of Object.values(r)) expect(v === null || ['string', 'number', 'boolean'].includes(typeof v)).toBe(true)
  }
})

test('a reload writes no duplicate: what was written is remembered per session', ON, async ($, on) => {
  const w = await world($, on)
  await w.turn([lim('five_hour', 40)])
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as never)
  await w.turn()
  expect(w.rows('limit').length).toBe(1)
  expect(w.rows('session_start').length).toBe(1)
})

test('lines already in the file stay, and a line another session dropped is put back', ON, async ($, on) => {
  const w = await world($, on)
  w.files.set(FILE, '{"ts":"2026-11-01T00:00:00.000Z","session":"other","kind":"limit"}')
  await w.turn([lim('five_hour', 40)])
  expect(w.rows().map(r => r.session)).toEqual(['other', 'live', 'live'])
  // Another session wrote the file back without our rows
  w.files.set(FILE, '{"ts":"2026-11-01T00:00:00.000Z","session":"other","kind":"limit"}\n')
  await w.turn([lim('five_hour', 41)])
  expect(w.rows('session_start').length).toBe(1)
  expect(w.rows('limit').filter(r => r.session === 'live').map(r => r.percent_used)).toEqual([40, 41])
})

test('a file that is there but cannot be read is not written over: the month goes on in part 2', ON, async ($, on) => {
  const w = await world($, on, { unreadable: FILE })
  await w.turn([lim('five_hour', 40)])
  expect(w.files.has(FILE)).toBe(false)
  expect((w.files.get(FILE.replace('.jsonl', '.2.jsonl')) || '').split('\n').filter(Boolean).length).toBe(2)
})

test('a write that fails is swallowed: no pop-up, the band still draws', ON, async ($, on) => {
  const w = await world($, on, { failWrites: true })
  await w.turn([lim('five_hour', 40)])
  await w.turn([lim('five_hour', 55)])
  expect(w.files.size).toBe(0)
  expect(w.t.env.toasts).toEqual([])
  expect(await w.t.drawn(await $.ui.mount({ plugin: 'token-report', surface: 'desktop', ...BAND } as never))).toContain('Context')
})

test('a Cache Warmer ping is logged with its cost and model', SLOW, async ($, on) => {
  const w = await world($, on, {
    settings: { away: 'warm-keep', keepWarm: '1h' },
    hooks: () => on('model.fork', async () => ({ value: { isAnswered: true, text: 'ok', usage: api(180_000, 0, 'claude-opus-5-5', 2, 3) } })),
  })
  await w.turn([lim('five_hour', 40)])
  await w.advance(58)
  await eventsIdle()
  const pings = w.rows('keep_warm')
  expect(pings.length).toBe(1)
  expect(w.rows('warm_start')).toMatchObject([{ model: 'claude-opus-5-5', tokens: 180_002, idle_min: 56 }])
  // 180k read at 0.20 $/M + 2 in at 4 + 3 out at 20
  expect(pings[0]).toMatchObject({ session: 'live', model: 'claude-opus-5-5', usd: 0.036068, tokens: 180_002, refreshed: true })
  // The 1 h duration ends: one stop row with the pause's pings and their cost
  await w.advance(10)
  await eventsIdle()
  expect(w.rows('warm_stop')).toMatchObject([{ reason: 'duration', pings: 1, usd: 0.036068 }])
})

test('your message ends the Cache Warmer: a stop row at the time of the message', SLOW, async ($, on) => {
  const w = await world($, on, {
    settings: { away: 'warm-keep', keepWarm: '2h' },
    hooks: () => on('model.fork', async () => ({ value: { isAnswered: true, text: 'ok', usage: api(180_000, 0, 'claude-opus-5-5', 2, 3) } })),
  })
  await w.turn([lim('five_hour', 40)])
  await w.advance(58)
  await w.turn()
  expect(w.rows('warm_stop')).toMatchObject([{ ts: '2026-11-10T09:58:00.000Z', reason: 'message', pings: 1 }])
})

test('the cold-send dialog is logged with what sending reloads and the choice', SLOW, async ($, on) => {
  const w = await world($, on, {
    settings: { away: 'keep', atTarget: 'off', billing: 'subscription', coldAsk: 'any' },
    // $.ui.ask reaches the test as an AskUserQuestion call
    first: () => on('tool.call', { tool: 'AskUserQuestion' }, async (_$: unknown, e: any) => ({ result: { questions: e.questions, answers: { [e.questions[0].question]: 'Cancel' } } })),
    hooks: () => {
      on('ui.log', async () => ({ value: undefined }))
      on('session.surfaces', async () => ({ value: [{ kind: 'desktop' }] }))
    },
  })
  await w.turn([lim('five_hour', 40)])
  await w.advance(61)
  await w.turn()
  // 180k written to a 1 h cache on Opus 5.5: 8 $/M
  expect(w.rows('cold_send')).toMatchObject([{ tokens: 180_000, usd: 1.44, model: 'claude-opus-5-5', choice: 'cancel' }])
})

test('a compaction that is refused writes no compact row', SLOW, async ($, on) => {
  const w = await world($, on, {
    settings: { away: 'compact', atTarget: 'off', billing: 'subscription' },
    hooks: () => on('session.compact', async () => { throw new Error('a turn is running') }),
  })
  await w.turn([lim('five_hour', 40)])
  await w.advance(58)
  await eventsIdle()
  expect(w.rows('compact')).toEqual([])
})

test('a compaction is logged with the size before and after, who ran it and the target', SLOW, async ($, on) => {
  const w = await world($, on, {
    settings: { away: 'compact', atTarget: 'off', billing: 'subscription', contextTarget: 300_000 },
    hooks: () => on('session.compact', async () => ({ messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }], tokensBefore: 180_000, tokensAfter: 20_000 })),
  })
  await w.turn([lim('five_hour', 40)])
  // The mod's own rule: 10 min before the 1 h cache goes cold
  await w.advance(52)
  await eventsIdle()
  expect(w.rows('compact')).toMatchObject([{ tokens_before: 180_000, tokens_after: 20_000, by: 'token_report', automatic: true, context_target: 300_000 }])
  // Claude Code's own, typed by the person, long after
  await w.advance(15)
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hello', toolUses: [] }] } as never)
  await eventsIdle()
  expect(w.rows('compact')[1]).toMatchObject({ by: 'claude_code', automatic: false, trigger: 'manual' })
})
