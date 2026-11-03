// token-report: wiring. Events feed the ledger (ledger.ts); the band (line.tsx) and the Settings pane
// (shell.tsx + pages/settings.tsx) draw from one Data snapshot. Only the Cache Warmer and compaction
// spend tokens, each on your press or a Settings switch. Watching never changes what Claude reads, so
// it costs no cache.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Settings, UiState } from '../types'
import { C, k, money, num, type Act, type Data, type PageCtx, type UI } from './kit'
import {
  addRequest, clockLeft, detectBilling, mainTtlMin, newLedger, noteAgentEnd, noteAgentStart,
  priceFor, promptOf, restore, rewriteUsd, snapshot, toUsage, EUR_PER_USD,
} from './ledger'
import type { Ledger, Ttl, Usage } from './ledger'
import { ctxTokens, drawLine, warnMinutes, type LineState, type UsageView } from './line'
import { drawShell } from './shell'

const PANE = 'token-report'
const PANE_TITLE = 'Token Report'
const SUB_TTL_MIN = 5
const DAY = 86_400_000

export const DEFAULT_SETTINGS: Settings = {
  billing: 'auto', contextTarget: 400_000, atTarget: 'remind',
  away: 'keep', keepWarm: '1h', compactNote: '', coldAsk: '0.5',
  currency: 'usd', eurRate: EUR_PER_USD,
}
// The values each setting may take: a stored or folder value outside them falls back to the default
const ALLOWED: { [K in keyof Settings]?: readonly string[] } = {
  billing: ['auto', 'subscription', 'api'],
  atTarget: ['off', 'remind', 'ask', 'compact'],
  away: ['compact', 'keep', 'warm-compact', 'warm-keep'],
  keepWarm: ['15m', '30m', '45m', '1h', '2h', '5h'],
  coldAsk: ['off', '0.25', '0.5', '1', 'any'],
  currency: ['usd', 'eur'],
}

const revA = atom({ plugin: 'token-report', key: 'rev' } as const, 0)
const uiA = atom({ plugin: 'token-report', key: 'ui' } as const, { isOpen: false } as UiState)
const settingsA = atom({ plugin: 'token-report', key: 'settings' } as const, DEFAULT_SETTINGS)
// The pane's own state (scope picked, a field opened): not kept across sessions
const viewA = atom({ plugin: 'token-report', key: 'view' } as const, {} as Record<string, string>)
// The band's animation frame: only the band reads it, so a tick redraws the band alone
const tickA = atom({ plugin: 'token-report', key: 'tick' } as const, 0)

// One scope's settings (the store, a folder file, an older version): its known keys with an allowed
// value only. Each scope is checked on its own, so a bad Project value falls back to Global, not the default.
function validSettings(saved: unknown): Partial<Settings> {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {}
  const v = { ...(saved as Record<string, unknown>) }
  const out: Record<string, unknown> = {}
  // Names used before 1.0
  if (v.atTarget === 'notify') v.atTarget = 'remind'
  if (v.atTarget === 'auto') v.atTarget = 'compact'
  if (v.away === 'off') v.away = 'keep'
  if (v.away === 'warm-only') v.away = 'warm-keep'
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const value = v[key]
    if (typeof value !== typeof DEFAULT_SETTINGS[key]) continue
    const allowed = ALLOWED[key]
    if (allowed && !allowed.includes(value as string)) continue
    if (typeof value === 'number' && (value < 0 || !Number.isFinite(value))) continue
    if (key === 'eurRate' && !((value as number) >= 0.5 && (value as number) <= 1.5)) continue
    // 0 is Max (Claude Code's own point); anything else 50k at least
    if (key === 'contextTarget' && (value as number) !== 0 && (value as number) < 50_000) continue
    if (key === 'compactNote' && (value as string).length > 2000) continue
    out[key] = value
  }
  return out as Partial<Settings>
}
// Defaults < Global < Project < Session, the live € rate over any stored one
const effectiveSettings = (): Settings => ({
  ...DEFAULT_SETTINGS, ...globalSettings, ...localSettings, ...chatSettings,
  ...(fx.isLive ? { eurRate: fx.rate } : {}),
})
// Read one scope's file or record afresh: another session may have changed it since
async function readProject($: EngineInterface, dir: string) {
  return validSettings(JSON.parse(await $.fs.read(dir + '/.token-report/settings.json')))
}

// ---- module state (rebuilt from $.store on a hot reload) ------------------------------------------
type Extra = Pick<Data, 'series'>
const freshLine = (): LineState => ({ growth: [], lastCtx: null, hit: null, turns: 0, compactions: 0, compacted: null })
const freshExtra = (): Extra => ({ series: [] })
let sid = 'session'
let L: Ledger = newLedger(sid, 0, null)
let s: LineState = freshLine()
let x: Extra = freshExtra()
let usage: UsageView = null
let compactAt: number | null = null
let windowTokens: number | null = null
let seenTtl: Ttl | null = null
let fx: Data['fx'] = { rate: EUR_PER_USD, asOf: '', isLive: false }
let warned = new Set<string>()
let isWorking = false
let isPinging = false
// When you last sent a message (main turn start): the Cache Warmer runs for its duration after it
let lastPromptAt = 0
// The prompt that starts the next turn came from no person (a schedule, a notification, a peer):
// that turn keeps the pause and its Cache Warmer going
let isNextTurnAuto = false
const AUTO_ORIGINS = new Set(['task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay', 'channel', 'coordinator', 'observer', 'observer-activity', 'auto-continuation', 'plugin'])
const WARM_NOTICE_MS = 10 * 60_000
// What your message's first request would rewrite, asked about before it is sent ('' = no question)
let askCold = ''
// A failed ping waits a minute before the next try (else every 15 s tick tried again)
let pingFailedAt = 0
const PING_RETRY_MS = 60_000
// The Cache Warmer's durations in minutes: hours on a 1 h cache, minutes on a 5 min one, where a
// ping every ~4 min costs more than one rewrite after about 45 min
const WARM_MIN: Record<string, number> = { '15m': 15, '30m': 30, '45m': 45, '1h': 60, '2h': 120, '5h': 300 }
const warmMinutes = (settings: Settings, ttlMin: number) => {
  const m = WARM_MIN[settings.keepWarm] ?? 60
  return ttlMin >= 60 ? Math.max(60, m) : Math.min(45, m)
}
// "Compact" acts this many minutes before a 1 h cache goes cold, and never below this size: a small
// chat costs little cold, and its summary would lose more than it saves
const COMPACT_BEFORE_MIN = 10
const AWAY_FLOOR = 50_000
// Claude Code's idle compaction threshold, read at session start; null when its idle compaction is off
let idleThreshold: number | null = 200_000
// Reminder and Ask come back every further 100k above the threshold
const THRESHOLD_STEP = 100_000
// The settings as stored for every session (Global), the project's file (Project) and this chat's (Session)
let globalSettings: Partial<Settings> = {}
let localSettings: Partial<Settings> = {}
let projectDir = ''
let chatSettings: Partial<Settings> = {}
let cwd = ''
// Ask: "Stop asking (this session)" was picked in this session; a threshold dialog is open
let stopAskingSid = ''
let isAsking = false
// The clock's repeating timers, cancelled before session.start sets them again
let timers: Timer[] = []
// The cold-send dialog's "Compact, then send" / "Use the summary": your message goes again after it
let resendText = ''
let askText = ''
// What "Compact, then send" asked the summary to focus on (kept for a retry)
let resendFocus = ''
// Counts session switches: work started on the clock for one chat never lands in the next
let gen = 0
const later = ($: EngineInterface, ms: number, fn: () => unknown) => {
  const at = gen
  $.clock.after(ms, async () => { if (gen === at) await fn() })
}
// A compaction started on the clock runs only if one is still owed: another path may have done it meanwhile
const compactLater = ($: EngineInterface, focus = '') => later($, 1500, () => isCompactOwed && compactNow($, focus))

const cap = <T,>(xs: T[], n = 200) => (xs.length > n ? xs.slice(-n) : xs)
const bump = ($: EngineInterface) => update($, revA, n => n + 1).catch(() => undefined)
const usdFor = (u: Usage, model: string | null) => {
  const p = priceFor(model, promptOf(u))
  return (u.cacheRead * p.cacheRead + u.input * p.input + u.output * p.output + u.cacheWrite * p.write5m) / 1e6
}

async function saveAll($: EngineInterface) {
  const at = await $.clock.now()
  try { await $.store.set('session:' + sid, { ...s, at }) } catch {}
  try { await $.store.set('ledger:' + sid, { at, ledger: snapshot(L) }) } catch {}
  // The pause's start and a kept idle summary too: a hot reload keeps the Cache Warmer going
  try { await $.store.set('extra:' + sid, { ...x, at, lastPromptAt, precomputedAt }) } catch {}
}
// A new session id: at start, after /clear (no session.start fires for it) or a resume. Nothing the
// last chat had pending carries over, and its Session settings are this chat's own.
async function openSession($: EngineInterface, id: string, now: number) {
  const isSwitch = id !== sid
  sid = id
  if (isSwitch) {
    gen += 1
    askCold = ''
    askText = ''
    resendText = ''
    resendFocus = ''
    isCompactOwed = false
    isNextTurnAuto = false
    lastSummary = null
    pingFailedAt = 0
  }
  const ls = (await $.store.get('session:' + sid)) as LineState | undefined
  s = ls && Array.isArray(ls.growth) ? { ...freshLine(), ...ls } : freshLine()
  const saved = (await $.store.get('ledger:' + sid)) as { ledger?: unknown } | undefined
  const engine = usage && usage.cost && num(usage.cost.usd) ? usage.cost.usd : null
  L = restore(saved && saved.ledger) || newLedger(sid, now, engine)
  const ex = (await $.store.get('extra:' + sid)) as (Extra & { lastPromptAt?: unknown; precomputedAt?: unknown }) | undefined
  x = ex && Array.isArray(ex.series) ? { ...freshExtra(), series: ex.series } : freshExtra()
  lastPromptAt = num(ex?.lastPromptAt) ? ex.lastPromptAt : 0
  precomputedAt = num(ex?.precomputedAt) ? ex.precomputedAt : 0
  warned = new Set()
  try {
    const c = (await $.store.get('chat:' + sid)) as Record<string, unknown> | undefined
    chatSettings = validSettings(c)
    // Kept alive while the chat is used (prune drops records older than 3 days)
    if (c) await $.store.set('chat:' + sid, { ...chatSettings, at: now })
  } catch { chatSettings = {} }
  await update($, settingsA, effectiveSettings).catch(() => undefined)
}
async function syncSession($: EngineInterface) {
  try {
    const id = String(await $.session.id())
    if (id !== sid) await openSession($, id, await $.clock.now())
  } catch {}
}
// Usage first: a new session's ledger starts from that session's cost, not the last one's
async function refresh($: EngineInterface) {
  try { usage = (await $.session.usage()) as unknown as UsageView } catch {}
  await syncSession($)
}
// Euros per dollar, only once € is chosen: the ECB reference rate (api.frankfurter.app, no key), at
// most twice a day, kept in $.store so a new session starts with it; the fixed rate stands in until a
// fetch succeeds. The rate is written into Settings.eurRate, so every amount follows it.
async function refreshFx($: EngineInterface) {
  try {
    if ((await read($, settingsA)).currency !== 'eur') return
    const saved = (await $.store.get('fx')) as { rate?: number; asOf?: string; fetchedAt?: number } | undefined
    const now = await $.clock.now()
    if (saved && num(saved.rate) && num(saved.fetchedAt) && now - saved.fetchedAt < 12 * 3_600_000) {
      fx = { rate: saved.rate, asOf: saved.asOf || '', isLive: true }
    } else {
      const r = await $.http.fetch('https://api.frankfurter.app/latest?from=USD&to=EUR')
      const body = JSON.parse(r.text) as { date?: string; rates?: { EUR?: number } }
      const rate = body.rates && body.rates.EUR
      if (!num(rate) || rate < 0.5 || rate > 1.5) return
      fx = { rate, asOf: body.date || '', isLive: true }
      await $.store.set('fx', { rate, asOf: fx.asOf, fetchedAt: now })
    }
    await update($, settingsA, effectiveSettings)
  } catch { /* offline or refused: keep the last rate */ }
}

async function refreshBreakdown($: EngineInterface) {
  try {
    const u = await $.session.usage({ breakdown: 'summary' })   // estimated locally, no API call
    const b = u.context.breakdown
    compactAt = b && b.isAutoCompactEnabled && num(b.autoCompactThreshold) ? b.autoCompactThreshold : null
    windowTokens = num(u.context.window) ? u.context.window : windowTokens
  } catch {}
}
// Old sessions' state after 3 days: the store holds 4 MiB in all
async function prune($: EngineInterface, now: number) {
  try {
    const isOld = async (key: string) => {
      const v = (await $.store.get(key)) as { at?: unknown } | undefined
      return !num(v?.at) || now - v.at > 3 * DAY
    }
    for (const key of await $.store.keys()) {
      if (!/^(session|ledger|extra|chat):/.test(key) || key.endsWith(':' + sid)) continue
      // A chat's Session settings stay while that chat is used, however long ago they were set
      if (key.startsWith('chat:') && !(await isOld('session:' + key.slice(5)))) continue
      if (await isOld(key)) await $.store.delete(key)
    }
  } catch {}
}

// The threshold in force: the one in Settings, but never past Claude Code's own auto-compact point
// (there Claude Code compacts first); Max (0) is that point itself
const thresholdOf = (settings: Settings) =>
  settings.contextTarget > 0 ? (num(compactAt) ? Math.min(settings.contextTarget, compactAt) : settings.contextTarget) : compactAt

// ---- one Data snapshot for the band and the pane ---------------------------------------------------
async function snapshotData($: EngineInterface): Promise<Data> {
  const now = await $.clock.now()
  const settings = await read($, settingsA)
  const billing = detectBilling(settings.billing, usage?.rateLimits, L.main.requests > 0)
  const ttlMin = mainTtlMin(billing.billing, seenTtl)
  const tokens = ctxTokens(usage)
  const sizeForCold = s.compacted ? s.compacted.after : tokens
  const model = L.main.model
  const p = priceFor(model, tokens ?? 0)
  return {
    now, L, s, usage, window: windowTokens, compactAt, target: thresholdOf(settings), billing, ttlMin,
    projectKeys: Object.keys(localSettings), sessionKeys: Object.keys(chatSettings), lastSummary, idleThreshold,
    folder: (projectDir || cwd).split(/[\\/]/).filter(Boolean).pop() || cwd,
    cacheLeft: clockLeft(L.main.lastRequestAt, ttlMin, now),
    rewriteUsd: num(sizeForCold) ? rewriteUsd(sizeForCold, model, ttlMin >= 60 ? '1h' : '5m') : null,
    pingUsd: num(tokens) ? (tokens * p.cacheRead + 60 * p.output) / 1e6 : null,
    series: x.series, fx,
  }
}

function toastOnce($: EngineInterface, id: string, text: string) {
  if (warned.has(id)) return
  warned.add(id)
  $.ui.toast(text)
}

// ---- actions ---------------------------------------------------------------------------------------
// The Cache Warmer holds the cache while one of its two choices is picked and its duration since your
// last message is not over. While it does, a summary Claude Code wrote ahead is kept, not put in (see the
// session.compact hooks). No message yet: nothing to keep warm.
const isWarmAway = (settings: Settings) => settings.away === 'warm-compact' || settings.away === 'warm-keep'
const isKeepAway = (settings: Settings) => settings.away === 'keep' || settings.away === 'warm-keep'
const isWarming = (settings: Settings, now: number, ttlMin: number) =>
  isWarmAway(settings) && lastPromptAt > 0 && now - lastPromptAt < warmMinutes(settings, ttlMin) * 60_000

// Keep the main cache warm: one fork reads the whole chat (a hit refreshes the lifetime). Evidence, not
// hope: the clock moves only when the fork's usage shows a cache read. A failure says so once per pause.
async function ping($: EngineInterface) {
  if (isPinging || isWorking) return
  isPinging = true
  try {
    const startedAt = await $.clock.now()
    const r = await $.model.fork({ prompt: 'Reply with the single word: ok' })
    if (!r.isAnswered) {
      pingFailedAt = startedAt
      toastOnce($, 'ping-failed-' + lastPromptAt, 'Cache Warmer: a ping failed (' + r.reason + ')')
      return
    }
    const u = toUsage(r.usage)
    noteAgentStart(L, 'keep-warm', { description: 'Cache Warmer pings (fork)', type: 'keep-warm', model: L.main.model || '', at: startedAt })
    const a = L.agents['keep-warm']!
    a.requests += 1
    a.usd += usdFor(u, L.main.model)
    a.tokens += promptOf(u) + u.output
    a.lastRequestAt = startedAt
    // An answer without a cache read kept nothing warm: it waits like a failure, not every 15 s
    if (u.cacheRead > 0) L.main.lastRequestAt = startedAt
    else pingFailedAt = startedAt
    await saveAll($)
    await bump($)
  } catch (err) {
    pingFailedAt = await $.clock.now()
    toastOnce($, 'ping-failed-' + lastPromptAt, 'Cache Warmer: a ping failed (' + String(err) + ')')
  } finally {
    isPinging = false
  }
}

// A compaction is owed: set at the threshold and by the cold-send dialog, cleared once one has run.
// Claude Code refuses /compact while a turn runs (a queued prompt starts right after the answer), so a
// refused one is tried again at the next quiet moment: the next turn's end, or the 15 s tick.
let isCompactOwed = false
let isCompacting = false
// When Claude Code last wrote an idle summary ahead that the mod let through (0: none kept)
let precomputedAt = 0
// The mod's own $.session.compact does not pass its own hooks, so compactNow runs afterCompaction too;
// `isCompactionSeen` keeps it to once
let isCompactionSeen = false
// The size the last compaction left, measured (Context management shows the next 10 messages after one)
let lastSummary: number | null = null

// After any compaction that stood: the pop-up, the band starts over, and a message the cold-send dialog
// held goes again
async function afterCompaction($: EngineInterface, r: { tokensBefore?: number; tokensAfter?: number }, sizeBefore: number | null) {
  isCompactionSeen = true
  const after = r.tokensAfter
  if (num(after)) lastSummary = after
  // The engine reports the sizes only when it compacted itself; else the size the band last showed
  const before = num(r.tokensBefore) ? r.tokensBefore : sizeBefore
  if (num(before)) $.ui.toast('Compacted ' + k(before) + (num(after) ? ' → ' + k(after) : ''))
  if (resendText) {
    const text = resendText
    resendText = ''
    later($, 500, async () => {
      lastPromptAt = await $.clock.now()
      await $.prompt.submit({ text, asUser: true }).catch(err => $.ui.toast('Token Report: could not send your message again (' + String(err) + ')'))
    })
  }
  s.growth = []
  s.lastCtx = null
  s.hit = null
  s.compacted = { after: num(after) ? after : null }
  s.compactions += 1
  // Any compaction (yours, Claude Code's own) settles what was owed and uses up a kept summary
  isCompactOwed = false
  precomputedAt = 0
  await saveAll($)
  await bump($)
  $.ui.invalidate('ui.render')
}

// Claude Code's own compaction, the same call /compact makes. Settings' compact instructions go with
// it, plus `focus` (the message the cold-send dialog sends again).
async function compactNow($: EngineInterface, focus = '') {
  if (isCompacting) return
  isCompacting = true
  // A retry (the first try fell inside the skipped turn) keeps the focus on the message waiting to go
  if (!focus && resendText && resendFocus) focus = resendFocus
  const note = (await read($, settingsA)).compactNote.trim()
  const instructions = [note, focus ? 'The user\'s next message, sent again right after this compaction: ' + focus : ''].filter(Boolean).join(' ')
  try {
    const sizeBefore = ctxTokens(usage)
    isCompactionSeen = false
    const out = await $.session.compact(instructions ? { instructions } : {})
    if (out && typeof out === 'object' && 'skip' in out && out.skip) {
      isCompactOwed = false
      resendText = ''
      $.ui.toast('Compaction skipped: ' + out.skip + (focus ? '. Your message was not sent again.' : ''))
      return
    }
    if (!isCompactionSeen && out && typeof out === 'object') await afterCompaction($, out as { tokensBefore?: number; tokensAfter?: number }, sizeBefore)
    isCompactOwed = false
  } catch (err) {
    // The desktop app hosts sessions over the SDK, where $.session.compact is not available: there a
    // compaction runs inside a turn, as the /compact command ($.prompt.submit refuses a text starting with /)
    if (/not available/i.test(String(err))) {
      isCompactOwed = false
      try {
        await $.command.run(instructions ? { command: 'compact', args: instructions } : { command: 'compact' })
      } catch (err2) {
        resendText = ''
        $.ui.toast('Compaction failed: ' + String(err2) + (focus ? '. Your message was not sent again.' : ''))
      }
      return
    }
    // Refused while a turn runs: tried again at the next quiet moment when one is owed, else say so
    if (!isCompactOwed) {
      $.ui.toast('Compaction failed: ' + String(err) + (resendText ? '. Your message was not sent again.' : ''))
      resendText = ''
    }
  } finally {
    isCompacting = false
  }
}

// Context management, checked after each main turn. Once a turn crosses the threshold, and again at
// every further 100k: Reminder pops up (Compact stays in the band), Ask opens a dialog, Compact compacts.
// Right after the turn the cache is warm, so compacting is cheap then. No pop-ups below the threshold:
// the band's colour already turns orange and red.
async function checkTarget($: EngineInterface) {
  const settings = await read($, settingsA)
  const tokens = ctxTokens(usage)
  const target = thresholdOf(settings)
  // Off: the mod stays quiet; Claude Code's own limit still applies
  if (!target || !num(tokens) || tokens < target || settings.atTarget === 'off') return
  const step = Math.floor((tokens - target) / THRESHOLD_STEP)
  const id = 'threshold-' + target + '-' + s.compactions + '-' + step
  if (warned.has(id)) {
    // Still owed after a refusal: try again now this turn has ended
    if (isCompactOwed) compactLater($)
    return
  }
  warned.add(id)
  const above = 'Context: ' + k(tokens) + ', above your ' + k(target) + ' threshold'
  // A summary that would not shrink the chat much is not worth its cost: Compact acts as a Reminder then
  const isWorthIt = !num(lastSummary) || tokens >= lastSummary * 1.5
  if (settings.atTarget === 'remind' || (settings.atTarget === 'compact' && !isWorthIt)) return void $.ui.toast(above)
  if (settings.atTarget === 'compact') {
    $.ui.toast('Context: ' + k(tokens) + ' (compacting)')
    isCompactOwed = true
    return void compactLater($)
  }
  if (stopAskingSid === sid || isAsking) return
  // Ask: started on the clock, the answer may take longer than a hook's budget. One dialog at a time,
  // and none once your next turn has started
  later($, 1500, async () => {
    if (isWorking || isAsking) return
    isAsking = true
    const answer = await $.ui.ask(above + '. Compact now? The cache is warm, so it is cheap now.', { header: 'Context', options: ['Compact', 'Not now', 'Stop asking (this session)'] }).catch(() => 'Not now')
    isAsking = false
    if (answer === 'Compact') return compactNow($)
    if (answer.startsWith('Stop asking')) stopAskingSid = sid
  })
}

// What the next send rewrites when the cache is cold and that costs more than the amount in Settings;
// null otherwise
async function coldSend($: EngineInterface) {
  const settings = await read($, settingsA)
  const d = await snapshotData($)
  if (d.cacheLeft === null || d.cacheLeft > 0 || d.rewriteUsd === null) return null
  const at = settings.coldAsk
  const rate = settings.currency === 'eur' ? settings.eurRate : 1
  if (at === 'off' || (at !== 'any' && d.rewriteUsd * rate < Number(at))) return null
  // On a subscription nothing is paid per send: the amount is what it would cost at API prices
  const price = money(d.rewriteUsd, settings, '≈') + (d.billing.billing === 'api' ? '' : ' at API prices')
  return k(d.s.compacted?.after ?? ctxTokens(d.usage)) + ' (' + price + ')'
}

// Cache pop-ups, the Cache Warmer and compacting while you are away, every 15 s between turns
async function cacheTick($: EngineInterface) {
  if (isWorking) return
  if (isCompactOwed) return void compactNow($)
  const settings = await read($, settingsA)
  const d = await snapshotData($)
  const left = d.cacheLeft
  if (left === null || s.compacted) return
  const lead = d.ttlMin >= 60 ? 4 : 1.25           // ping this many minutes before expiry
  // The Cache Warmer pings shortly before expiry, for its duration after your last message
  const warming = isWarming(settings, d.now, d.ttlMin)
  // Ten minutes into a pause it says it holds the cache, once per pause
  if (warming && lastPromptAt > 0 && d.now - lastPromptAt >= WARM_NOTICE_MS) toastOnce($, 'warm-' + lastPromptAt, 'Cache Warmer')
  if (warming && left > 0 && left <= lead && d.now - pingFailedAt >= PING_RETRY_MS) return void ping($)
  const tokens = ctxTokens(usage)
  const isBig = num(tokens) && tokens >= AWAY_FLOOR
  // Its duration is over: say so once. "then compact" compacts now, while the cache is still warm (else it
  // goes cold at full size); a kept idle summary is used if Claude Code still has one
  if (!warming && isWarmAway(settings) && lastPromptAt > 0 && !warned.has('warm-end-' + lastPromptAt)) {
    toastOnce($, 'warm-end-' + lastPromptAt, 'Cache Warmer stopped')
    if (settings.away === 'warm-compact' && left > 0 && isBig) void compactNow($)
  }
  // "Compact": shortly before a 1 h cache goes cold, once per pause, under Claude Code's idle threshold
  // (from it on, Claude Code's own idle compaction writes its summary and puts it in when you return).
  // Not on a 5 min cache: compacting after every short pause would cost more than it saves
  const isUnderIdle = num(tokens) && (idleThreshold === null || tokens < idleThreshold)
  if (settings.away === 'compact' && d.ttlMin >= 60 && lastPromptAt > 0 && left > 0 && left <= COMPACT_BEFORE_MIN && isBig && isUnderIdle && !warned.has('away-' + lastPromptAt)) {
    warned.add('away-' + lastPromptAt)
    return void compactNow($)
  }
  if (left > 0 && left <= warnMinutes(d.ttlMin) && !warming) toastOnce($, 'cache-' + L.main.lastRequestAt, 'Cache: ' + Math.max(1, Math.ceil(left)) + 'm')
}

function makeAct($: EngineInterface): Act {
  return {
    // Global: every session on this computer. Project: the project's .token-report/settings.json (the
    // session's folder or the nearest one above it with that file), over Global. Session: this chat
    // only, over both, kept until the session ends. A write that fails changes nothing and says so.
    setSetting: async (key, value) => {
      const scope = (await read($, viewA))['settings.scope'] || 'global'
      try {
        // Each write starts from what is stored now, so another session's change to another key stays
        if (scope === 'project') {
          const dir = projectDir || cwd
          if (!dir) throw new Error('this session has no folder')
          const next = { ...(await readProject($, dir).catch(() => ({}))), [key]: value }
          await $.fs.write(dir + '/.token-report/settings.json', JSON.stringify(next, null, 2) + '\n')
          localSettings = next
          projectDir = dir
        } else if (scope === 'session') {
          const next = { ...chatSettings, [key]: value }
          await $.store.set('chat:' + sid, { ...next, at: await $.clock.now() })
          chatSettings = next
        } else {
          const next = { ...validSettings(await $.store.get('settings')), [key]: value }
          await $.store.set('settings', next)
          globalSettings = next
        }
      } catch (err) {
        $.ui.toast('Token Report: the setting was not saved (' + String(err) + ')')
        return
      }
      await update($, settingsA, effectiveSettings)
      if (key === 'currency' && value === 'eur') void refreshFx($)
      await bump($)
    },
    // Model calls run past a press's 10 s budget: start them on the clock, the press settles at once
    compact: async () => { $.clock.after(0, () => void compactNow($)) },
  }
}

async function openPane($: EngineInterface) {
  await update($, uiA, () => ({ isOpen: true }))
  try { await $.store.set('pane.open', true) } catch {}
  await $.ui.open({ id: PANE, title: PANE_TITLE })
}
async function closePane($: EngineInterface) {
  await update($, uiA, () => ({ isOpen: false }))
  try { await $.store.set('pane.open', false) } catch {}
  await $.ui.close({ id: PANE })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      const now = await $.clock.now()
      await refresh($)
      await openSession($, String(await $.session.id()), now)
      try { globalSettings = validSettings(await $.store.get('settings')) } catch {}
      try { cwd = await $.session.cwd() } catch {}
      // Where Claude Code's idle compaction starts (its env var, floor 100k), or null when it is off
      try {
        const isOff = (await $.settings.read({ key: 'idleCompaction' })) === false
        const raw = Number(await $.env.get('CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS'))
        idleThreshold = isOff ? null : Number.isFinite(raw) && raw > 0 ? Math.max(100_000, raw) : 200_000
      } catch {}
      // The project's .token-report/settings.json, in the session's folder or the nearest folder above it.
      // A git worktree is a folder of its own: it finds the file only if it has one.
      localSettings = {}
      projectDir = ''
      const parts = cwd.split(/[\\/]/)
      for (let n = parts.length; n > 0 && !projectDir; n--) {
        const dir = parts.slice(0, n).join('/')
        try {
          localSettings = await readProject($, dir)
          projectDir = dir
        } catch {}
      }
      await update($, settingsA, effectiveSettings)
      if ((await $.store.get('pane.open')) === true) {
        await update($, uiA, () => ({ isOpen: true }))
        void $.ui.open({ id: PANE, title: PANE_TITLE })
      }
      await refreshBreakdown($)
      await refreshFx($)
      await prune($, now)
      await $.command.register({ name: 'tokens', description: 'Token Report: open its Settings' })
    } catch { /* drawing copes with missing data */ }
    for (const timer of timers) timer.cancel()
    timers = [
      $.clock.every(15_000, async () => {
        await refresh($)
        await cacheTick($)
        await bump($)
        $.ui.invalidate('ui.render')
      }),
      $.clock.every(5 * 60_000, () => refreshBreakdown($)),
      $.clock.every(6 * 3_600_000, () => refreshFx($)),
      // The working animation: a frame every 350 ms while a main turn runs, nothing otherwise
      $.clock.every(350, async () => {
        if (isWorking) await update($, tickA, t => t + 1)
      }),
    ]
    return next(e)
  })

  on('command.run', { command: 'tokens' }, async $ => {
    await openPane($)
    return { text: 'Token Report opened.' }
  })

  // /model while the cache is warm: Claude Code asks first, with the price of the switch
  on('classic.PreModelSwitch', async ($, e, next) => {
    seenTtl = e.cache_ttl
    const settings = await read($, settingsA)
    const r = await next(e)
    if (!e.prompt_cache_warm || !num(e.estimated_cache_write_usd) || e.estimated_cache_write_usd * (settings.currency === 'eur' ? settings.eurRate : 1) < 0.05) return r
    if (r && r.permissionDecision) return r
    return { ...(r || {}), permissionDecision: 'ask' as const, permissionDecisionReason: 'The cache is warm: switching re-caches ' + k(e.context_tokens) + ' tokens on ' + e.to_model.replace('claude-', '') + ', ' + money(e.estimated_cache_write_usd, settings) + ' at list price.' }
  })

  // Claude Code's idle compaction writes its summary ahead (`precompute`) ~54 min into a pause, once
  // per pause, from its threshold up. Keep full (with or without the Cache Warmer): vetoed, the full
  // context stays. Otherwise always let it write, also while the Cache Warmer runs (a veto then lost it
  // for the whole pause): the summary is only kept, and the mod decides below when it goes in.
  // Settings' compact instructions go to it too.
  on('session.compact', { trigger: 'precompute' }, async ($, e, next) => {
    if (e.agentId) return next(e)
    const settings = await read($, settingsA)
    if (isKeepAway(settings)) return { skip: 'Token Report keeps the full context while you are away' }
    const note = settings.compactNote.trim()
    const r = await next(note && !e.instructions ? { ...e, instructions: note } : e)
    // A result may carry `skip: undefined`: only a reason counts as skipped
    if (r && !r.skip) {
      precomputedAt = await $.clock.now()
      await saveAll($)
    }
    return r
  })

  // A kept summary goes in on your next message (trigger `auto`). With the Cache Warmer on and the cache
  // still warm that would throw away what the warmer paid for: keep the full context, keep the summary.
  on('session.compact', { trigger: 'auto' }, async ($, e, next) => {
    if (e.agentId || !precomputedAt) return next(e)
    const settings = await read($, settingsA)
    const tokens = ctxTokens(usage)
    const isAtLimit = num(compactAt) && num(tokens) && tokens >= compactAt * 0.95
    if (!isWarmAway(settings) || isAtLimit) return next(e)
    const left = (await snapshotData($)).cacheLeft
    if (left === null || left <= 0) return next(e)
    return { skip: 'the cache is still warm (Token Report Cache Warmer): keeping the full context' }
  })

  on('session.compact', async ($, e, next) => {
    const sizeBefore = ctxTokens(usage)
    const r = await next(e)
    if (e.agentId || e.trigger === 'precompute' || !r || r.skip) return r
    await afterCompaction($, r as { tokensBefore?: number; tokensAfter?: number }, sizeBefore)
    return r
  })

  on('session.end', async ($, e, next) => {
    const r = await next(e)
    if (e.reason === 'clear' || e.reason === 'resume') {
      await refresh($)
      $.ui.invalidate('ui.render')
    }
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    // One delivered into a running turn starts none
    if (!e.turnId) {
      const isAuto = AUTO_ORIGINS.has(e.origin?.kind as string)
      // Your own message on a cold cache: the dialog waits for the turn's first request (turn.step).
      // Here, before the turn, the desktop app shows no dialog, and a drop would lose the text.
      askCold = !isAuto && !e.isMeta && !e.command ? (await coldSend($)) ?? '' : ''
      // Your words only: the desktop app appends <system-reminder> blocks to a typed prompt, which must
      // go neither into the compact instructions nor into the message sent again
      // A message with images or files can't be sent again whole (a plugin's prompt carries text only):
      // its dialog offers no second choice
      askText = askCold && !e.attachments?.length ? e.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim() : ''
      // A message of yours replaces one still waiting for a compaction to finish
      // and the compaction it was waiting for (one owed at the threshold stays)
      if (!isAuto && !e.command && resendText) {
        resendText = ''
        isCompactOwed = false
      }
      isNextTurnAuto = isAuto
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      isWorking = true
      const isAuto = isNextTurnAuto
      isNextTurnAuto = false
      // You're back: the pause and its Cache Warmer start over with your message
      if (!isAuto) lastPromptAt = await $.clock.now()
    }
    return next(e)
  })

  // Every model request; the cache clock starts when one is sent. Before your message's first request
  // on a cold cache, the dialog: Send anyway, the second choice, or Cancel (no request is made, a grey
  // line says so, the message stays for the next send). A dialog that can't be shown lets the request
  // go: a warning must never eat a message. The second choice: with a summary Claude Code wrote ahead,
  // putting it in costs almost nothing; without one, compacting first costs about the same now, but
  // every later message is cheaper.
  on('turn.step', async function* ($, e, next) {
    if (askCold && !e.agentId && e.index === 0) {
      const cold = askCold
      const text = askText
      askCold = ''
      askText = ''
      const hasSummary = precomputedAt > 0
      const second = hasSummary ? 'Use the summary' : 'Compact, then send'
      const question = 'Your chat went cold. Sending reloads all ' + cold + '. ' + (!text
        ? 'Send it now?'
        : hasSummary
        ? 'A summary is ready: using it costs almost nothing, then your message goes on the small chat.'
        : 'Compacting first costs about the same now, but every later message is cheaper.')
      // Closing the dialog cancels (the message stays in the chat, nothing is spent). With no surface
      // drawing it (a -p run) nobody can answer: the request goes
      const options = text ? ['Send anyway', second, 'Cancel'] : ['Send anyway', 'Cancel']
      const answer = await $.ui.ask(question, { header: 'Cold cache', options })
        .catch(async () => ((await $.session.surfaces().catch(() => [])).length ? 'Cancel' : 'Send anyway'))
      const skipped = { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
      if (answer === 'Cancel') {
        $.ui.log('Token Report: not sent, the cache is cold (' + cold + '). Your message stays; send again to go ahead.')
        return skipped
      }
      if (answer === second && text) {
        $.ui.log('Token Report: ' + (hasSummary ? 'putting in the summary' : 'compacting') + ' first; your message goes again right after.')
        resendText = text
        resendFocus = hasSummary ? '' : text
        // After this (skipped) turn has ended; a refusal is tried again at the next quiet moment
        isCompactOwed = true
        compactLater($, resendFocus)
        return skipped
      }
    }
    const startedAt = await $.clock.now()
    const it = next(e)
    let r = await it.next()
    while (!r.done) {
      yield r.value
      r = await it.next()
    }
    const res = r.value
    if (res && res.usage) {
      const endedAt = await $.clock.now()
      const model = (res.usage as { model?: string }).model || e.model
      const tools = (res.toolUses || []).map(t => t.name)
      const billing = detectBilling((await read($, settingsA)).billing, usage?.rateLimits, true)
      addRequest(L, { turnId: e.turnId, index: e.index, agentId: e.agentId || null, model, effort: e.effort, startedAt, endedAt, usage: toUsage(res.usage), tools }, mainTtlMin(billing.billing, seenTtl), SUB_TTL_MIN)
      await bump($)
    }
    return res
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    const id = r && (r as { agentId?: string }).agentId
    if (id) {
      noteAgentStart(L, id, {
        description: e.description, type: e.subagentType || 'general-purpose', model: (r as { model: string }).model,
        toolUseId: e.tool_use_id, workflow: !!e.workflow, at: await $.clock.now(),
      })
      await bump($)
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.agentId) {
      noteAgentEnd(L, e.agentId, now)
      await saveAll($)
      return next(e)
    }
    isWorking = false
    await refresh($)
    const u = e.usage
    if (u) {
      const u4 = toUsage(u)
      const prompt = promptOf(u4)
      s.turns += 1
      s.hit = prompt ? Math.round((u4.cacheRead / prompt) * 100) : null
    }
    const ctx = ctxTokens(usage)
    if (ctx !== null) {
      if (s.lastCtx !== null && !s.compacted) s.growth = [...s.growth, ctx - s.lastCtx].filter(num).slice(-3)
      s.lastCtx = ctx
      if (u) s.compacted = null
      const t = L.turns[e.turnId]
      x.series = cap([...x.series, { at: now, turnId: e.turnId, ctx, usd: t ? t.usd + t.agentsUsd : 0, rewrite: !!(t && t.rewrites) }], 400)
    }
    await saveAll($)
    await bump($)
    $.ui.invalidate('ui.render')
    void checkTarget($).catch(() => undefined)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await refresh($)
    await bump($)
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const ui = $.ui.resolve(e) as unknown as UI
    const theirs = await next(e)
    const { isOpen } = await read($, uiA)
    const settings = await read($, settingsA)
    const d = await snapshotData($)
    // The Report button, pinned at the band's left edge: opens and closes the pane
    const head = <ui.Button key="trn-pane" label="≣ Report" variant="primary" onPress={() => void (isOpen ? closePane($) : openPane($))} />
    const act = makeAct($)
    const line = drawLine(ui, { d, settings, isWorking: !!e.props.isWorking, head, frame: await read($, tickA), onCompact: () => void act.compact(), columns: num(e.props.bodyColumns) ? e.props.bodyColumns : undefined })
    return (theirs ? <ui.Box flexDirection="column">{line}{theirs}</ui.Box> : line) as never
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const r = await next(e)
    if (e.origin.kind === 'person') {
      await update($, uiA, () => ({ isOpen: false }))
      try { await $.store.set('pane.open', false) } catch {}
    }
    return r
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e) as unknown as UI
    await read($, revA)
    const view = await read($, viewA)
    const ctx: PageCtx = {
      ui, data: await snapshotData($), settings: await read($, settingsA), act: makeAct($),
      columns: num(e.props.bodyColumns) ? e.props.bodyColumns : 80,
      get: (key, fallback) => view[key] ?? fallback,
      set: (key, value) => void update($, viewA, st => ({ ...st, [key]: value })),
    }
    try {
      return drawShell(ctx) as never
    } catch (err) {
      return (<ui.Text color={C.red}>Token Report failed to draw: {String(err)}</ui.Text>) as never
    }
  })
}
