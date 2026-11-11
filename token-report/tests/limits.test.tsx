import { expect, mock, test } from 'claude-code/testing'

import { eventsIdle, resetRows } from '../hooks/events'
import { bandLimits, OTHER_MODEL_PERCENT, STALE_MS, type AppReading } from '../hooks/line'
import { BAND, api, setup } from './harness'

// The band's plan limits from two sources (the engine's last reply, the app's usage card), the
// tightest weekly window, the "as of" mark, and the event log's limit_reset row.
const MIN = 60_000
const START = Date.UTC(2026, 10, 11, 13, 0, 0)
const FIVE_RESET = '2026-11-11T17:30:00.000Z'
const WEEK_RESET = '2026-11-14T03:00:00.000Z'
const FILE = 'C:/Users/Test/.claude/data-lake/token-report/events-2026-11.jsonl'
const ON = { options: { eventLogFolder: '~/.claude/data-lake/token-report' } }
const lim = (kind: string, percentUsed: number, resetsAt = kind === 'five_hour' ? FIVE_RESET : WEEK_RESET) => ({ kind, percentUsed, resetsAt })
const win = (label: string, percentUsed: number, resetsAt = label.startsWith('5') ? FIVE_RESET : WEEK_RESET) => ({ label, percentUsed, resetsAt })
const card = (windows: unknown[]) => ({ result: '', text: JSON.stringify({ plan: { status: 'ok', windows } }) })

// ---- bandLimits: which reading the band shows ----------------------------------------------------------
const usage = (limits: unknown[]) => ({ rateLimits: limits }) as never
const reading = (at: number, windows: ReturnType<typeof win>[]): AppReading => ({ at, windows })

test('bandLimits: per window the newer reading; the engine alone without the app', () => {
  const u = usage([lim('five_hour', 21), lim('seven_day', 85)])
  const app = reading(START + MIN, [win('5-hour limit', 2), win('Weekly · all models', 35)])
  const b = bandLimits(u, START, app, 'claude-opus-5-5')
  expect([b.five?.percentUsed, b.five?.source, b.week?.percentUsed, b.week?.source]).toEqual([2, 'app', 35, 'app'])
  const older = bandLimits(u, START + 2 * MIN, app, 'claude-opus-5-5')
  expect([older.five?.percentUsed, older.five?.source]).toEqual([21, 'engine'])
  const alone = bandLimits(u, 0, null, null)
  expect([alone.five?.percentUsed, alone.week?.percentUsed, alone.five?.at]).toEqual([21, 85, 0])
  expect(bandLimits(null, 0, null, null)).toEqual({ five: undefined, week: undefined })
})

test('bandLimits: a fuller per-model weekly window shows when it is the session\'s model or at 90 % or more', () => {
  const u = usage([lim('seven_day', 85)])
  const app = (fable: number) => reading(START + MIN, [win('Weekly · all models', 85), win('Weekly · Fable', fable)])
  // The session runs on Fable: the fuller Fable window shows, named
  expect(bandLimits(u, START, app(88), 'claude-fable-5-2').week).toMatchObject({ name: 'Fable', percentUsed: 88 })
  // Another model: only from OTHER_MODEL_PERCENT on
  expect(bandLimits(u, START, app(OTHER_MODEL_PERCENT - 1), 'claude-opus-5-5').week).toMatchObject({ percentUsed: 85, kind: 'Weekly · all models' })
  expect(bandLimits(u, START, app(OTHER_MODEL_PERCENT - 1), 'claude-opus-5-5').week?.name).toBe(undefined)
  expect(bandLimits(u, START, app(98), 'claude-opus-5-5').week).toMatchObject({ name: 'Fable', percentUsed: 98 })
  // Model not known yet: the same as another model
  expect(bandLimits(u, START, app(88), null).week?.name).toBe(undefined)
  // Not fuller than the general window: the general one
  expect(bandLimits(u, START, app(80), 'claude-fable-5-2').week?.name).toBe(undefined)
})

// ---- resetRows: the limit_reset row -------------------------------------------------------------------
const NOW = Date.UTC(2026, 11 - 1, 11, 13, 26)
test('resetRows: a fall before the reset time is one row with before and after; the normal roll-over is none', () => {
  const seen = { five_hour: '21|' + FIVE_RESET, seven_day: '85|' + WEEK_RESET, 'app:Weekly · Fable': '100|' + WEEK_RESET }
  const r = resetRows([lim('five_hour', 1, '2026-11-11T18:20:00.000Z'), lim('seven_day', 34)], seen, {}, {}, NOW)
  expect(r.rows).toEqual([
    { limit: 'five_hour', percent_before: 21, percent_after: 1, resets_at_before: FIVE_RESET, resets_at_after: '2026-11-11T18:20:00.000Z', source: 'engine' },
    { limit: 'seven_day', percent_before: 85, percent_after: 34, resets_at_before: WEEK_RESET, resets_at_after: WEEK_RESET, source: 'engine' },
  ])
  expect(Object.keys(r.noted)).toEqual(['five_hour', 'seven_day'])
  // The app's names are kept apart from the engine's
  expect(resetRows([win('Weekly · Fable', 0)], seen, {}, {}, NOW, 'app').rows.map(x => [x.limit, x.source])).toEqual([['Weekly · Fable', 'app']])
  // The roll-over: at (or a few minutes before, the time being rounded) the reset time
  const rolled = Date.parse(FIVE_RESET) - 10_000
  expect(resetRows([lim('five_hour', 0, '2026-11-11T22:30:00.000Z')], seen, {}, {}, rolled).rows).toEqual([])
  expect(resetRows([lim('five_hour', 0)], seen, {}, {}, Date.parse(FIVE_RESET) + MIN).rows).toEqual([])
  // A one-point wobble with the reset time unchanged, a rise, a window never seen: none
  expect(resetRows([lim('seven_day', 84), lim('five_hour', 30), lim('spend_limit', 3)], seen, {}, {}, NOW).rows).toEqual([])
})

test('resetRows: a drop another session noted after this one\'s last reading is the same reset', () => {
  const seen = { seven_day: '84|' + WEEK_RESET }
  const noted = { seven_day: { from: WEEK_RESET, at: NOW - MIN } }
  // Our last row for it was written before the other session noted the reset: same drop, no row
  expect(resetRows([lim('seven_day', 35)], seen, { seven_day: NOW - 20 * MIN }, noted, NOW).rows).toEqual([])
  // Our last reading came after that note: a second reset in the same week
  expect(resetRows([lim('seven_day', 35)], seen, { seven_day: NOW - 30_000 }, noted, NOW).rows.length).toBe(1)
})

// ---- live: the band and the log -----------------------------------------------------------------------
async function world($: any, on: any, answer: () => unknown) {
  let asked = 0
  on('tool.call', { tool: 'mcp__ccd_session_mgmt__get_usage' }, async () => { asked++; return answer() as never })
  const t = setup($, on, START)
  mock.env(on, { USERPROFILE: 'C:\\Users\\Test' })
  const files = new Map<string, string>()
  const slash = (p: string) => p.split(String.fromCharCode(92)).join('/')
  on('fs.exists', async (_$: unknown, e: { path: string }) => ({ value: files.has(slash(e.path)) }))
  on('fs.read', async (_$: unknown, e: { path: string }) => {
    const text = files.get(slash(e.path))
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', async (_$: unknown, e: { path: string; text: string }) => { files.set(slash(e.path), e.text); return { value: undefined } })
  on('turn.start', async (_$: unknown, e: unknown) => e as never)
  on('prompt.submit', async (_$: unknown, e: { text: string }) => ({ text: e.text }))
  t.store['settings'] = { billing: 'subscription' }
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as never)
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 5)); await eventsIdle() }
  const turn = async (limits: unknown[], model = 'claude-opus-5-5') => {
    t.env.limits = limits
    await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'sdk' } } as never)
    await $.turn.start({ turnId: 't1', text: 'go' } as never)
    await t.step({}, api(180_000, 0, model), [])
    await t.complete({ usage: api(180_000, 0, model) })
    await settle()
  }
  const band = async () => t.drawn(await $.ui.mount({ plugin: 'token-report', surface: 'desktop', ...BAND, props: { ...BAND.props, bodyColumns: 200 } } as never))
  const rows = (kind: string) => (files.get(FILE) || '').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>).filter(r => r.kind === kind)
  return { t, turn, band, rows, settle, asked: () => asked }
}

test('the band shows the app\'s fresher reading, and the tightest weekly window by name', { timeoutMs: 60_000 }, async ($, on) => {
  const w = await world($, on, () => card([win('5-hour limit', 2, '2026-11-11T18:20:00.000Z'), win('Weekly · all models', 35), win('Weekly · Fable', 98)]))
  // The engine still says 21 % and 85 % (its last reply was before the reset); the app knows better
  await w.turn([lim('five_hour', 21), lim('seven_day', 85)])
  const text = await w.band()
  expect(text).toContain('5h: 2%')
  expect(text).toContain('Weekly Fable: 98%')
  expect(text).not.toContain('as of')
  // Asked at the session's start and at the turn's end; the message right after the start asked nothing
  expect(w.asked()).toBe(2)
})

test('the app\'s usage tool asked while the band is drawn: every 5 minutes, not more', { timeoutMs: 60_000 }, async ($, on) => {
  const w = await world($, on, () => card([win('5-hour limit', 2), win('Weekly · all models', 35)]))
  await w.turn([lim('five_hour', 21), lim('seven_day', 85)])
  const before = w.asked()
  for (let i = 0; i < 12; i++) {
    await w.band()
    await w.t.clock.advance(MIN)
    await w.settle()
  }
  // 12 minutes with the band in view: two or three timer calls (the first one 5 min after the start)
  expect(w.asked() - before).toBeGreaterThanOrEqual(2)
  expect(w.asked() - before).toBeLessThanOrEqual(3)
})

test('no app reading (a denied tool) and an idle session: the band says how old its figure is', { timeoutMs: 60_000 }, async ($, on) => {
  const w = await world($, on, () => ({ deny: 'no rule allows it' }))
  await w.turn([lim('five_hour', 21), lim('seven_day', 85)])
  expect(await w.band()).not.toContain('as of')
  for (let i = 0; i < 11; i++) await w.t.clock.advance(MIN)
  await w.settle()
  const text = await w.band()
  expect(text).toContain('5h: 21%')
  expect(text).toMatch(/Weekly: 85% · as of \d\d:\d\d/)
  // Denied once: never asked again in this session
  expect(w.asked()).toBe(1)
  expect(STALE_MS).toBe(10 * MIN)
})

test('an early reset writes one limit_reset row per window and source, besides the limit rows', { timeoutMs: 60_000, ...ON }, async ($, on) => {
  let fable = 100
  const w = await world($, on, () => card([win('Weekly · all models', fable ? 85 : 35), win('Weekly · Fable', fable)]))
  await w.turn([lim('five_hour', 21), lim('seven_day', 85)])
  expect(w.rows('limit_reset')).toEqual([])
  // Reset in the Claude app: both sources see it after the next turn
  fable = 0
  await w.t.clock.advance(MIN)
  await w.turn([lim('five_hour', 1, '2026-11-11T18:20:00.000Z'), lim('seven_day', 34)])
  const resets = w.rows('limit_reset').map(r => [r.limit, r.percent_before, r.percent_after, r.source])
  expect(resets).toEqual([
    ['five_hour', 21, 1, 'engine'], ['seven_day', 85, 34, 'engine'],
    ['Weekly · all models', 85, 35, 'app'], ['Weekly · Fable', 100, 0, 'app'],
  ])
  expect(w.rows('limit').filter(r => r.limit === 'Weekly · Fable').map(r => r.percent_used)).toEqual([100, 0])
  // The same values again: no second row
  await w.t.clock.advance(MIN)
  await w.turn([lim('five_hour', 1, '2026-11-11T18:20:00.000Z'), lim('seven_day', 34)])
  expect(w.rows('limit_reset').length).toBe(4)
  // Noted for the other sessions
  expect(Object.keys(w.t.store['limit-resets'] as object).sort()).toEqual(['app:Weekly · Fable', 'app:Weekly · all models', 'five_hour', 'seven_day'])
})
