// token-report: wiring. Events feed the ledger (ledger.ts); the band (line.tsx) and the Settings pane
// (shell.tsx + pages/settings.tsx) draw from one Data snapshot. Only the Cache Warmer and compaction
// spend tokens, each on your press or a Settings switch. Watching never changes what Claude reads, so
// it costs no cache.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Settings, UiState } from '../types'
import { eventsIdle, isEventLogOn, limitRows, logEvent, planOf, startEventLog, usd6 } from './events'
import { C, k, money, num, type Act, type Data, type PageCtx, type UI } from './kit'
import {
  addRequest, clockLeft, detectBilling, mainTtlMin, newLedger, noteAgentEnd, noteAgentStart,
  priceFor, promptOf, restore, rewriteUsd, sessionUsd, snapshot, toUsage, EUR_PER_USD,
} from './ledger'
import type { Ledger, Ttl, Usage } from './ledger'
import {
  amountMatters, answerOf, classifyStart, forkCarryUsd, forkGuardFires, handBackAgent, handBackFork, handBackModel,
  isExpensive, jobKey, noteExplicit, ratioTo, roundTripUsd, samePrice, savingUsd, startResult, SUGGESTED,
  type Answer, type Cls, type Signal,
} from './router'
import { ctxTokens, drawLine, warnMinutes, type LineState, type UsageView } from './line'
import { drawShell } from './shell'
import { asRecord, buildTree, ownRecord, MAX_SIDES, SIDE_KEY, type Side, type SideRec } from './agents'
import { mergeLayers, profileView, withProfile, type Profile } from './profile'

const PANE = 'token-report'
const PANE_TITLE = 'Token Report'
const SUB_TTL_MIN = 5
const DAY = 86_400_000

export const DEFAULT_SETTINGS: Settings = {
  billing: 'auto', profile: 'auto', contextTarget: 400_000, atTarget: 'remind', unattended: 'count',
  agentStarts: 'count', sessionStarts: 'count',
  away: 'keep', keepWarm: '1h', compactNote: '', coldAsk: '0.5',
  currency: 'usd', eurRate: EUR_PER_USD,
}
// The values each setting may take: a stored or folder value outside them falls back to the default
const ALLOWED: { [K in keyof Settings]?: readonly string[] } = {
  billing: ['auto', 'subscription', 'api'],
  profile: ['auto', 'managed'],
  atTarget: ['off', 'remind', 'ask', 'compact'],
  unattended: ['count', 'act'],
  agentStarts: ['count', 'act'],
  sessionStarts: ['count', 'act'],
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
// Defaults < Global < Project < Session, each with its profile expanded (a key set by hand in a scope
// beats that scope's profile; a profile beats everything below it), the live € rate over any stored one
const effectiveSettings = (): Settings => ({
  ...(mergeLayers([DEFAULT_SETTINGS, globalSettings, localSettings, chatSettings]) as Settings),
  ...(fx.isLive ? { eurRate: fx.rate } : {}),
})
const profileNow = (settings: Settings) => profileView([
  { scope: 'default', values: {} }, { scope: 'global', values: globalSettings }, { scope: 'project', values: localSettings }, { scope: 'session', values: chatSettings },
], settings)
// Read one scope's file or record afresh: another session may have changed it since
async function readProject($: EngineInterface, dir: string) {
  return validSettings(JSON.parse(await $.fs.read(dir + '/.token-report/settings.json')))
}

// ---- module state (rebuilt from $.store on a hot reload) ------------------------------------------
// This session as the desktop app names it, and the session that started it ('' when none)
type SelfRec = { local: string; parent: string; detached: boolean; title: string }
type Extra = Pick<Data, 'series'> & { sides: Side[]; self: SelfRec | null }
const freshLine = (): LineState => ({ growth: [], lastCtx: null, hit: null, turns: 0, compactions: 0, compacted: null })
const freshExtra = (): Extra => ({ series: [], sides: [], self: null })
// The started sessions' own records (store `side:<local id>`), read back for the Agents page's layers
let records: Record<string, SideRec> = {}
let recordsSig = ''
// get_session("self") asked in this session already (once)
let isSelfAsked = false
// The pane is open (a copy of uiA's isOpen the 15 s tick reads without a state call)
let isPaneOpen = false
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
// The running main turn came from no person: nobody would answer a cold dialog in the middle of it
let isTurnAuto = false
// ---- turns nobody typed (setting `unattended`) -------------------------------------------------------
// Compact-first's form, for a turn nobody typed that wakes a cold cache. 'skip-turn' (built, safe): the
// turn's first request is skipped, the mod compacts after that turn, then sends the text again framed.
// 'hold-prompt': hold the prompt in prompt.submit, compact, then let it through. Switch to it only once
// live check S1 shows Claude Code runs a /compact from there instead of refusing it.
const COMPACT_FIRST: 'skip-turn' | 'hold-prompt' = 'skip-turn'
type WakeAction = 'none' | 'compact_after' | 'use_summary' | 'compact_first' | 'sent_cold'
// One turn nobody typed: where it came from, the cache as it found it, what Act does about a cold cache
// (`b`), whether Act is on, and what the mod did before the turn's first request
type Wake = { origin: string; at: number; tokens: number | null; cold: boolean; reloadUsd: number | null; b: WakeAction; act: boolean; did: WakeAction }
// The next turn's (set at prompt.submit) and the running turn's
let nextWake: Wake | null = null
let wake: Wake | null = null
// The context the running main turn's first request read
let firstTokens: number | null = null
// A peer's or notification's text compact-first holds back: it goes again after the compaction, framed
// as the mod's message, never as your own words (asUser), with its wrapper as it came
let resendFramed = ''
// When Claude Code last put in a summary it wrote ahead (trigger auto)
let autoSummaryAt = 0
// A started child's first turn: its brief came from the parent session (get_session("self"), asked
// once, lazily at the first request; undefined: not asked). The answer: yes, until that turn has ended
let childCheck: Promise<void> | undefined
let isChildBrief = false
// Main-thread AskUserQuestion calls waiting on your answer: the turn runs, but nothing is sent meanwhile
let waitingAsks = 0
// ---- agent and session starts (settings `agentStarts`, `sessionStarts`; plan/v2-slice2-router.md) ----
// The note for an expensive model named on purpose rides on the Agent tool's result as `context`. Off
// switches it to counting only: live check L2 shows whether the model reads it on the desktop app.
const NOTE_VIA_CONTEXT = true
// The session tools the fork guard and model-at-start watch (hand_off raising tool.call: live check L4)
const START_SESSION = 'mcp__ccd_session__start_session'
const HAND_OFF = 'mcp__ccd_session__hand_off_to_session'
// After this many re-issues on the expensive model the caller has said no: no more hand-backs this session
const MAX_INSISTS = 3
type About = 'agent' | 'session_model' | 'session_fork'
// A hand-back waiting for the caller's next start of the same job in the same loop ('main' or an agent id)
type Pending = { id: string; job: string; loop: string; about: About; parent: string }
let pending: Pending[] = []
// Jobs handed back once in this session (agents by job, session starts as 's:' + job): never again
let handedBack = new Set<string>()
let insists = 0
// The explicit-choice note is given once per session; the Agent calls that carry it, by tool_use_id
let isNoted = false
const noteFor = new Map<string, string>()
// The effort an Agent call gave (agent.spawn has none), by tool_use_id
const effortOf = new Map<string, string>()
// What an agent type with no model named resolved to, learned from its starts: inherits or not
let typeModel: Record<string, string> = {}
// CLAUDE_CODE_SUBAGENT_MODEL, read once at session start: then no omitted model inherits ('' = unset)
let subagentModel = ''
// The main thread's model as its last request named it
let mainModel = ''

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
// The event log (events.ts): what the last limit rows written for this session said, whether its
// session_start row is written (both stored, so a reload repeats nothing), the mod's version from its
// plugin.json, and the compaction the mod itself last asked for (who asked, when)
let limitSeen: Record<string, string> = {}
let isStartLogged = false
let modVersion = ''
type Cause = 'threshold' | 'cold_send' | 'away' | 'wake' | 'button'
let modCompact: { isByUser: boolean; at: number; cause: Cause } | null = null
const MOD_COMPACT_MS = 10 * 60_000
// The compaction owed was asked for by you (the cold-send dialog), not by a rule
let isOwedByUser = false
// Why the compaction owed is owed (the event log's `cause`)
let owedCause: Cause = 'threshold'
// Counts session switches: work started on the clock for one chat never lands in the next
let gen = 0
const later = ($: EngineInterface, ms: number, fn: () => unknown) => {
  const at = gen
  $.clock.after(ms, async () => { if (gen === at) await fn() })
}
// A compaction started on the clock runs only if one is still owed: another path may have done it meanwhile
const compactLater = ($: EngineInterface, focus = '') => later($, 1500, () => isCompactOwed && startCompact($, focus, false, owedCause))
// A compaction the mod asks for, noted for the event log (who asked, when) before compactNow runs it.
// The note stands until a compaction lands or 10 minutes pass: a refused one is tried again later.
async function startCompact($: EngineInterface, focus = '', isByUser = false, cause: Cause = 'threshold') {
  if (!isCompacting) modCompact = { isByUser: isByUser || (isCompactOwed && isOwedByUser), at: await $.clock.now().catch(() => 0), cause }
  return compactNow($, focus)
}
// The event log's rows for what the mod does to prevent cost. The Cache Warmer per pause (a pause starts
// with your message at lastPromptAt): warm_start before its first ping, keep_warm per ping, warm_stop
// when its duration is over or you are back. Kept in memory only: a reload mid-pause starts a new count.
let warm = { pause: 0, pings: 0, usd: 0 }
function logPing($: EngineInterface, at: number, u: Usage, refreshed: boolean) {
  if (!isEventLogOn()) return
  const model = L.main.model
  if (warm.pause !== lastPromptAt || !warm.pings) {
    warm = { pause: lastPromptAt, pings: 0, usd: 0 }
    void logEvent($, sid, 'warm_start', at, { model, tokens: promptOf(u), idle_min: lastPromptAt > 0 ? Math.round((at - lastPromptAt) / 60_000) : null })
  }
  const usd = usd6(usdFor(u, model))
  warm.pings += 1
  warm.usd += usd
  void logEvent($, sid, 'keep_warm', at, { usd, model, tokens: promptOf(u), refreshed })
}
function logWarmStop($: EngineInterface, reason: 'duration' | 'message', at: number) {
  if (!warm.pings) return
  void logEvent($, sid, 'warm_stop', at, { reason, pings: warm.pings, usd: usd6(warm.usd) })
  warm = { pause: 0, pings: 0, usd: 0 }
}
// The desktop app's own usage card has windows the mod API does not report (a per-model weekly limit).
// Asked through the app's tool once per main turn end, never awaited by a hook. A call that is denied
// (a permission mode with no rule allowing it), fails or finds no such tool (the terminal) ends it for
// this session; "unavailable" is asked again next turn.
let appLimits: 'ask' | 'asking' | 'off' = 'ask'
async function sampleAppLimits($: EngineInterface, at: number) {
  if (appLimits !== 'ask') return
  appLimits = 'asking'
  const of = sid
  try {
    const plan = planOf(await $.tool.call({ tool: 'mcp__ccd_session_mgmt__get_usage' } as never))
    if (of !== sid) return
    if (!plan || plan.status === 'not_applicable') return void (appLimits = 'off')
    appLimits = 'ask'
    if (plan.status !== 'ok') return
    const moved = limitRows(plan.windows, limitSeen, 'app')
    limitSeen = moved.seen
    for (const row of moved.rows) void logEvent($, sid, 'limit', at, row)
  } catch {
    if (of === sid) appLimits = 'off'
  }
}
// The cold-send dialog was shown: what sending would reload, and what you chose
async function logCold($: EngineInterface, choice: 'send' | 'compact_then_send' | 'use_summary' | 'cancel') {
  if (!isEventLogOn()) return
  try {
    const d = await snapshotData($)
    const tokens = d.s.compacted?.after ?? ctxTokens(d.usage)
    void logEvent($, sid, 'cold_send', d.now, { tokens: num(tokens) ? tokens : null, usd: num(d.rewriteUsd) ? usd6(d.rewriteUsd) : null, model: L.main.model, choice })
  } catch {}
}

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
  try { await $.store.set('extra:' + sid, { ...x, at, lastPromptAt, precomputedAt, limitSeen, isStartLogged }) } catch {}
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
    isOwedByUser = false
    modCompact = null
    appLimits = 'ask'
    isNextTurnAuto = false
    nextWake = null
    wake = null
    resendFramed = ''
    autoSummaryAt = 0
    childCheck = undefined
    isChildBrief = false
    lastSummary = null
    pingFailedAt = 0
    pending = []
    handedBack = new Set()
    insists = 0
    isNoted = false
    noteFor.clear()
    effortOf.clear()
    typeModel = {}
    mainModel = ''
    records = {}
    recordsSig = ''
    isSelfAsked = false
  }
  const ls = (await $.store.get('session:' + sid)) as LineState | undefined
  s = ls && Array.isArray(ls.growth) ? { ...freshLine(), ...ls } : freshLine()
  const saved = (await $.store.get('ledger:' + sid)) as { ledger?: unknown } | undefined
  const engine = usage && usage.cost && num(usage.cost.usd) ? usage.cost.usd : null
  L = restore(saved && saved.ledger) || newLedger(sid, now, engine)
  const ex = (await $.store.get('extra:' + sid)) as (Extra & { lastPromptAt?: unknown; precomputedAt?: unknown; limitSeen?: unknown; isStartLogged?: unknown }) | undefined
  x = ex && Array.isArray(ex.series) ? {
    ...freshExtra(), series: ex.series, sides: Array.isArray(ex.sides) ? ex.sides : [],
    self: ex.self && typeof ex.self === 'object' && typeof (ex.self as SelfRec).local === 'string' ? ex.self as SelfRec : null,
  } : freshExtra()
  if (x.self) isSelfAsked = true
  lastPromptAt = num(ex?.lastPromptAt) ? ex.lastPromptAt : 0
  precomputedAt = num(ex?.precomputedAt) ? ex.precomputedAt : 0
  limitSeen = ex?.limitSeen && typeof ex.limitSeen === 'object' ? { ...(ex.limitSeen as Record<string, string>) } : {}
  isStartLogged = ex?.isStartLogged === true
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
      if (!/^(session|ledger|extra|chat|side):/.test(key) || key.endsWith(':' + sid)) continue
      // This session's own record is written again each turn
      if (x.self && key === SIDE_KEY + x.self.local) continue
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
    profile: profileNow(settings),
    tree: buildTree(x.self?.local || '', Object.values(L.agents), x.sides, records),
    hasProject: !!(projectDir || cwd),
  }
}

// ---- the layers below this session (v2 slice 3) ---------------------------------------------------------
// Off: no session writes or reads a `side:` record, and the Agents page shows this session's own agents
// and its started sessions without money. Assumed, not shown live: two sessions writing the store in the
// same second lose no key (live check L3 in plan/v2-slice3-agents.md)
const LAYERS = true
// Every started session writes its own flat record; the reader links them by parent. Only while this
// session has a parent (it is someone's side session): a top session writes nothing.
async function writeOwnRecord($: EngineInterface, now: number) {
  const me = x.self
  if (!LAYERS || !me || !me.local || !me.parent) return
  try {
    await $.store.set(SIDE_KEY + me.local, ownRecord(L, sessionUsd(L, usage?.cost?.usd), me, x.sides, now))
  } catch {}
}
// Every record in the store (one file per machine); kept only when one changed, so the page redraws then
async function readRecords($: EngineInterface): Promise<boolean> {
  if (!LAYERS) return false
  try {
    const next: Record<string, SideRec> = {}
    for (const key of await $.store.keys()) {
      if (!key.startsWith(SIDE_KEY)) continue
      const rec = asRecord(await $.store.get(key))
      if (rec) next[key.slice(SIDE_KEY.length)] = rec
    }
    const sig = JSON.stringify(next)
    if (sig === recordsSig) return false
    records = next
    recordsSig = sig
    return true
  } catch { return false }
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
      logPing($, startedAt, toUsage(r.usage), false)
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
    logPing($, startedAt, u, u.cacheRead > 0)
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
async function afterCompaction($: EngineInterface, r: { tokensBefore?: number; tokensAfter?: number }, sizeBefore: number | null, trigger?: string) {
  isCompactionSeen = true
  const after = r.tokensAfter
  if (num(after)) lastSummary = after
  // The engine reports the sizes only when it compacted itself; else the size the band last showed
  const before = num(r.tokensBefore) ? r.tokensBefore : sizeBefore
  let cause: Cause | null = null
  // The event log: who ran it and whether a person asked for it. One the mod asked for shortly before
  // is the mod's, also when it ran as Claude Code's /compact (the desktop app's way), and so is one that
  // lands while the mod still owes one (a refused compaction waits, queued, for the turn to end).
  try {
    const now = await $.clock.now()
    const mine = modCompact && now - modCompact.at < MOD_COMPACT_MS ? modCompact : isCompactOwed ? { isByUser: isOwedByUser, cause: owedCause } : null
    cause = mine ? mine.cause : null
    modCompact = null
    if (trigger === 'auto') autoSummaryAt = now
    const cu = (r as { usage?: unknown }).usage
    void logEvent($, sid, 'compact', now, {
      tokens_before: num(before) ? before : null, tokens_after: num(after) ? after : null,
      by: mine || trigger === undefined || trigger === 'plugin' ? 'token_report' : 'claude_code',
      automatic: mine ? !mine.isByUser : trigger !== 'manual',
      trigger: trigger ?? 'plugin', context_target: (await read($, settingsA)).contextTarget,
      cause, usd: cu ? usd6(usdFor(toUsage(cu), L.main.model)) : null,
    })
  } catch {}
  if (num(before)) $.ui.toast('Compacted ' + k(before) + (num(after) ? ' → ' + k(after) : '') + (cause === 'wake' ? ' (turn nobody typed)' : ''))
  sendFramed($, 500)
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
  isOwedByUser = false
  precomputedAt = 0
  await saveAll($)
  await bump($)
  $.ui.invalidate('ui.render')
}

// The text compact-first held back goes again: framed as this mod's message (no asUser), so the model
// never reads a peer's or a notification's words as yours. Also when the compaction failed or was
// skipped: a message nobody typed is never lost, it then simply goes on the cold cache.
function sendFramed($: EngineInterface, ms: number) {
  if (!resendFramed) return
  const text = resendFramed
  resendFramed = ''
  later($, ms, () => $.prompt.submit({ text }).catch(err => $.ui.toast('Token Report: could not deliver a message again (' + String(err) + ')')))
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
      sendFramed($, 0)
      return
    }
    if (!isCompactionSeen && out && typeof out === 'object') await afterCompaction($, out as { tokensBefore?: number; tokensAfter?: number }, sizeBefore)
    isCompactOwed = false
  } catch (err) {
    // The desktop app hosts sessions over the SDK, where $.session.compact is not available: there a
    // compaction runs inside a turn, as the /compact command ($.prompt.submit refuses a text starting with /)
    if (/not available/i.test(String(err))) {
      try {
        await $.command.run(instructions ? { command: 'compact', args: instructions } : { command: 'compact' })
        isCompactOwed = false
      } catch (err2) {
        refused($, err2, focus)
      }
      return
    }
    refused($, err, focus)
  } finally {
    isCompacting = false
  }
}

// A compaction Claude Code refused. While a turn runs (a press on ⤓, the threshold, an away compaction
// during a long turn) it is only queued: owed, and run at the next quiet moment (the turn's end or the
// 15 s tick), with the message waiting for it kept. Between turns a refusal is a real failure: say so.
function refused($: EngineInterface, err: unknown, focus: string) {
  if (isWorking) {
    isCompactOwed = true
    toastOnce($, 'compact-queued-' + s.compactions, 'Compaction queued: runs after this turn')
    return
  }
  isCompactOwed = false
  $.ui.toast('Compaction failed: ' + String(err) + (focus || resendText ? '. Your message was not sent again.' : ''))
  resendText = ''
  sendFramed($, 0)
}

// Context management, checked after each main turn. Once a turn crosses the threshold, and again at
// every further 100k: Reminder pops up (Compact stays in the band), Ask opens a dialog, Compact compacts.
// Right after the turn the cache is warm, so compacting is cheap then. No pop-ups below the threshold:
// the band's colour already turns orange and red. After a turn nobody typed (`isAuto`) nobody is there
// to answer: Ask pops up like Reminder, and under Act (`wk.act`) the mod compacts whatever Reminder or
// Ask say, after every such turn above the threshold. Returns whether the context ended above the
// threshold, whether a compaction is now on its way, and whether Act would start one (the event log).
async function checkTarget($: EngineInterface, isAuto = false, wk: Wake | null = null) {
  const settings = await read($, settingsA)
  const tokens = ctxTokens(usage)
  const target = thresholdOf(settings)
  const out = { isAbove: !!target && num(tokens) && tokens >= target, did: false, would: false }
  // Off: the mod stays quiet; Claude Code's own limit still applies
  if (!out.isAbove || !num(tokens) || !target || settings.atTarget === 'off') return out
  // A summary that would not shrink the chat much is not worth its cost: Compact acts as a Reminder then
  const isWorthIt = !num(lastSummary) || tokens >= lastSummary * 1.5
  // Compact-first already compacts after this turn
  out.would = isWorthIt && wk?.did !== 'compact_first'
  if (wk?.act && out.would) {
    isCompactOwed = true
    isOwedByUser = false
    owedCause = 'wake'
    compactLater($)
    return { ...out, did: true }
  }
  const step = Math.floor((tokens - target) / THRESHOLD_STEP)
  const id = 'threshold-' + target + '-' + s.compactions + '-' + step
  if (warned.has(id)) {
    // Still owed after a refusal: try again now this turn has ended
    if (isCompactOwed) compactLater($)
    return out
  }
  warned.add(id)
  const above = 'Context: ' + k(tokens) + ', above your ' + k(target) + ' threshold'
  if (settings.atTarget === 'remind' || (settings.atTarget === 'compact' && !isWorthIt) || (settings.atTarget === 'ask' && isAuto)) {
    $.ui.toast(above)
    return out
  }
  if (settings.atTarget === 'compact') {
    $.ui.toast('Context: ' + k(tokens) + ' (compacting)')
    isCompactOwed = true
    isOwedByUser = false
    owedCause = 'threshold'
    compactLater($)
    return { ...out, did: true }
  }
  if (stopAskingSid === sid || isAsking) return out
  // Ask: started on the clock, the answer may take longer than a hook's budget. One dialog at a time,
  // and none once your next turn has started
  later($, 1500, async () => {
    if (isWorking || isAsking) return
    isAsking = true
    const answer = await $.ui.ask(above + '. Compact now? The cache is warm, so it is cheap now.', { header: 'Context', options: ['Compact', 'Not now', 'Stop asking (this session)'] }).catch(() => 'Not now')
    isAsking = false
    if (answer === 'Compact') return startCompact($, '', true, 'threshold')
    if (answer.startsWith('Stop asking')) stopAskingSid = sid
  })
  return out
}

// The cache right now: cold or not, the size and price of what the next send reloads, and whether that
// is above the amount in Settings ("Ask before a cold send")
async function coldState($: EngineInterface) {
  const settings = await read($, settingsA)
  const d = await snapshotData($)
  const size = d.s.compacted?.after ?? ctxTokens(d.usage)
  const usd = d.rewriteUsd
  const isCold = d.cacheLeft !== null && d.cacheLeft <= 0 && usd !== null
  const at = settings.coldAsk
  const rate = settings.currency === 'eur' ? settings.eurRate : 1
  const isAbove = isCold && at !== 'off' && (at === 'any' || (usd as number) * rate >= Number(at))
  return { settings, d, tokens: num(size) ? size : null, usd, isCold, isAbove }
}

// What the next send rewrites when the cache is cold and that costs more than the amount in Settings;
// null otherwise
async function coldSend($: EngineInterface) {
  const c = await coldState($)
  if (!c.isAbove || c.usd === null) return null
  // On a subscription nothing is paid per send: the amount is what it would cost at API prices
  const price = money(c.usd, c.settings, '≈') + (c.d.billing.billing === 'api' ? '' : ' at API prices')
  return k(c.tokens) + ' (' + price + ')'
}

// A turn nobody typed is about to start: the cache as it finds it, and what Act does about a cold one
// (case B): put in a summary Claude Code wrote ahead, else compact first, else (a prompt with images or
// files, which can't be sent again whole) send it as is. Only from AWAY_FLOOR up and above the amount.
async function wakeAt($: EngineInterface, origin: string, hasAttachments: boolean): Promise<Wake> {
  const c = await coldState($)
  const isBig = c.tokens !== null && c.tokens >= AWAY_FLOOR
  const b: WakeAction = !c.isAbove || !isBig ? 'none' : precomputedAt > 0 ? 'use_summary' : hasAttachments ? 'sent_cold' : 'compact_first'
  return { origin, at: c.d.now, tokens: c.tokens, cold: c.isCold, reloadUsd: c.isCold ? c.usd : null, b, act: c.settings.unattended === 'act', did: 'none' }
}

// Is this session a child another session started and still holds (not detached)? Asked through the
// desktop app's own tool; denied, failed or not there (the terminal): no, origins alone decide
async function isHeldChild($: EngineInterface) {
  isSelfAsked = true
  try {
    const r = (await $.tool.call({ tool: 'mcp__ccd_session_mgmt__get_session', session_id: 'self' } as never)) as { deny?: unknown; isError?: unknown; result?: unknown; text?: unknown } | null
    if (!r || typeof r !== 'object' || r.deny || r.isError) return false
    const find = (v: unknown, depth: number): Record<string, unknown> | null => {
      if (!v || typeof v !== 'object' || depth > 3) return null
      const o = v as Record<string, unknown>
      if ('parentSessionId' in o) return o
      for (const child of Object.values(o)) {
        const hit = find(child, depth + 1)
        if (hit) return hit
      }
      return null
    }
    for (const v of [r.result, r.text]) {
      try {
        const rec = find(typeof v === 'string' ? JSON.parse(v) : v, 0)
        if (rec) {
          const parent = typeof rec.parentSessionId === 'string' ? rec.parentSessionId : ''
          if (typeof rec.sessionId === 'string' && rec.sessionId.startsWith('local_')) {
            x.self = { local: rec.sessionId, parent, detached: rec.detached !== false, title: typeof rec.title === 'string' ? rec.title.slice(0, 80) : '' }
          }
          return parent !== '' && rec.detached === false
        }
      } catch { /* not JSON: try the other field */ }
    }
  } catch {}
  return false
}

// The event log's `wake` line, at the end of a turn nobody typed. `action`: what happened; `would`: what
// Act would have done, under Count only too
function logWake($: EngineInterface, wk: Wake, a: { isAbove: boolean; did: boolean; would: boolean }, now: number) {
  if (!isEventLogOn()) return
  const isSummaryIn = autoSummaryAt > 0 && autoSummaryAt >= wk.at - 10_000
  const would: WakeAction = wk.b === 'compact_first' || wk.b === 'use_summary' ? wk.b : a.would ? 'compact_after' : isSummaryIn ? 'use_summary' : wk.b
  const action: WakeAction = wk.did === 'compact_first' ? 'compact_first' : isSummaryIn ? 'use_summary' : a.did ? 'compact_after' : wk.cold ? 'sent_cold' : 'none'
  void logEvent($, sid, 'wake', now, {
    origin: wk.origin, tokens: firstTokens ?? wk.tokens, cold: wk.cold, reload_usd: num(wk.reloadUsd) ? usd6(wk.reloadUsd) : null,
    above_target: a.isAbove, setting: wk.act ? 'act' : 'count', action, would, model: L.main.model,
  })
}

// Cache pop-ups, the Cache Warmer and compacting while you are away, every 15 s between turns. While a
// turn waits on a question to you, only the pop-up: Claude Code refuses a compaction inside a turn, and
// a Cache Warmer fork would replay a request whose question has no answer yet.
async function cacheTick($: EngineInterface) {
  if (isWorking && waitingAsks === 0) return
  if (isWorking) {
    const d = await snapshotData($)
    const left = d.cacheLeft
    if (left !== null && left > 0 && left <= warnMinutes(d.ttlMin)) toastOnce($, 'cache-' + L.main.lastRequestAt, 'Cache: ' + Math.max(1, Math.ceil(left)) + 'm (a question is waiting for you)')
    return
  }
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
    logWarmStop($, 'duration', d.now)
    if (settings.away === 'warm-compact' && left > 0 && isBig) void startCompact($, '', false, 'away')
  }
  // "Compact": shortly before a 1 h cache goes cold, once per pause, under Claude Code's idle threshold
  // (from it on, Claude Code's own idle compaction writes its summary and puts it in when you return).
  // Not on a 5 min cache: compacting after every short pause would cost more than it saves
  const isUnderIdle = num(tokens) && (idleThreshold === null || tokens < idleThreshold)
  if (settings.away === 'compact' && d.ttlMin >= 60 && lastPromptAt > 0 && left > 0 && left <= COMPACT_BEFORE_MIN && isBig && isUnderIdle && !warned.has('away-' + lastPromptAt)) {
    warned.add('away-' + lastPromptAt)
    return void startCompact($, '', false, 'away')
  }
  if (left > 0 && left <= warnMinutes(d.ttlMin) && !warming) toastOnce($, 'cache-' + L.main.lastRequestAt, 'Cache: ' + Math.max(1, Math.ceil(left)) + 'm')
}

// One scope's settings rewritten. Each write starts from what is stored now, so another session's change
// to another key stays. A write that fails changes nothing and says so.
async function writeScope($: EngineInterface, scope: string, change: (prev: Partial<Settings>) => Partial<Settings>): Promise<boolean> {
  try {
    if (scope === 'project') {
      const dir = projectDir || cwd
      if (!dir) throw new Error('this session has no folder')
      const next = change(await readProject($, dir).catch(() => ({})))
      await $.fs.write(dir + '/.token-report/settings.json', JSON.stringify(next, null, 2) + '\n')
      localSettings = next
      projectDir = dir
    } else if (scope === 'session') {
      const next = change(chatSettings)
      await $.store.set('chat:' + sid, { ...next, at: await $.clock.now() })
      chatSettings = next
    } else {
      const next = change(validSettings(await $.store.get('settings')))
      await $.store.set('settings', next)
      globalSettings = next
    }
  } catch (err) {
    $.ui.toast('Token Report: the setting was not saved (' + String(err) + ')')
    return false
  }
  await update($, settingsA, effectiveSettings)
  await bump($)
  return true
}

function makeAct($: EngineInterface): Act {
  return {
    // Global: every session on this computer. Project: the project's .token-report/settings.json (the
    // session's folder or the nearest one above it with that file), over Global. Session: this chat
    // only, over both, kept until the session ends. A write that fails changes nothing and says so.
    setSetting: async (key, value) => {
      const scope = (await read($, viewA))['settings.scope'] || 'global'
      if (!(await writeScope($, scope, prev => ({ ...prev, [key]: value })))) return
      if (key === 'currency' && value === 'eur') void refreshFx($)
    },
    // A profile into the scope picked (or Project, for the Agents page's button), and that scope's own
    // bundle keys removed, so the row reads clean afterwards
    setProfile: async (value: Profile, scope?: 'project') => {
      const into = scope || (await read($, viewA))['settings.scope'] || 'global'
      await writeScope($, into, prev => withProfile(prev, value))
    },
    // Model calls run past a press's 10 s budget: start them on the clock, the press settles at once
    compact: async () => { $.clock.after(0, () => void startCompact($, '', true, 'button')) },
  }
}

async function openPane($: EngineInterface) {
  isPaneOpen = true
  await update($, uiA, () => ({ isOpen: true }))
  try { await $.store.set('pane.open', true) } catch {}
  await $.ui.open({ id: PANE, title: PANE_TITLE })
}
async function closePane($: EngineInterface) {
  isPaneOpen = false
  await update($, uiA, () => ({ isOpen: false }))
  try { await $.store.set('pane.open', false) } catch {}
  await $.ui.close({ id: PANE })
}

// ---- agent and session starts ------------------------------------------------------------------------
// A start's lines are written before its hook returns: a write still pending once the hook's frame has
// ended is lost (the deny path returns at once). Only while the event log is on.
const logged = () => (isEventLogOn() ? eventsIdle() : Promise.resolve())
// The calling loop's context and cache: the main thread's, or a subagent's (its last request). Mid-turn
// the cache is warm; a start from a turn that woke a cold one finds it cold.
async function callerState($: EngineInterface, agentId: string | undefined, now: number) {
  let last: { startedAt: number; usage: Usage } | undefined
  for (let i = L.requests.length - 1; i >= 0 && !last; i--) if ((L.requests[i]!.agentId || undefined) === agentId) last = L.requests[i]
  const settings = await read($, settingsA)
  const ttlMin = agentId ? SUB_TTL_MIN : mainTtlMin(detectBilling(settings.billing, usage?.rateLimits, L.main.requests > 0).billing, seenTtl)
  const tokens = last ? promptOf(last.usage) : agentId ? null : ctxTokens(usage)
  const left = last ? clockLeft(last.startedAt, ttlMin, now) : null
  return { tokens: num(tokens) ? tokens : null, isCold: left !== null && left <= 0, ttlMin }
}

// Does a start with no model named run on its parent's model? An agent definition or
// CLAUDE_CODE_SUBAGENT_MODEL may set one; null: not known yet (a type not seen before)
function inheritsOf(type: string, named: string, parent: string, isFork: boolean): boolean | null {
  if (isFork) return true
  if (named || subagentModel) return false
  if (type === 'general-purpose') return true
  const seen = typeModel[type]
  return seen === undefined ? null : samePrice(seen, parent)
}

// The caller's next start answered a hand-back (or none came before its loop ended: dropped)
function logAnswer($: EngineInterface, p: Pending, answer: Answer, at: number, fields: { agent_id?: string | null; child?: string | null; model?: string | null } = {}) {
  pending = pending.filter(q => q !== p)
  if (answer === 'same_model' || answer === 'other_model' || answer === 'fork_again') insists += 1
  void logEvent($, sid, 'hand_back_answer', at, {
    hand_back_id: p.id, answer, agent_id: fields.agent_id ?? null, child: fields.child ?? null, model: fields.model ?? null,
  })
}

type AgentPlan = {
  cls: Cls; signal: Signal; job: string; loop: string; inherits: boolean | null; tokens: number | null; isCold: boolean
  would: 'none' | 'hand_back' | 'note' | 'unknown'; saving: number | null; roundTrip: number | null; answering: Pending | undefined
}
// What the rules say about an agent start, under either setting (count logs it as `would`)
async function planAgent($: EngineInterface, e: { subagentType: string; description: string; prompt: string; model?: string; parentModel: string; parentAgentId?: string; fork: boolean; workflow?: unknown; resume?: unknown; isTeammate?: true }, now: number): Promise<AgentPlan> {
  const c = classifyStart(e.subagentType, e.description, e.prompt)
  const job = jobKey(e.prompt)
  const loop = e.parentAgentId || 'main'
  const named = e.model || ''
  const inherits = inheritsOf(e.subagentType || 'general-purpose', named, e.parentModel, e.fork)
  const answering = pending.find(p => p.about === 'agent' && p.job === job && p.loop === loop)
  const st = await callerState($, e.parentAgentId, now)
  const out: AgentPlan = { ...c, job, loop, inherits, tokens: st.tokens, isCold: st.isCold, would: 'none', saving: null, roundTrip: null, answering }
  // Workflow, resume, teammate and agent forks: counted only (a deny breaks a script, parks an agent;
  // a fork's model can't change)
  if (e.workflow || e.resume || e.isTeammate || e.fork || c.cls !== 'gather') return out
  if (named) return { ...out, would: isExpensive(named) ? 'note' : 'none' }
  if (!isExpensive(e.parentModel)) return out
  if (inherits === null) return { ...out, would: 'unknown' }
  if (!inherits || answering || handedBack.has(job) || insists >= MAX_INSISTS) return out
  const saving = savingUsd(e.parentModel)
  const roundTrip = st.tokens === null ? null : roundTripUsd(st.tokens, e.parentModel, st.isCold, st.ttlMin)
  const isWorth = st.tokens === null || amountMatters(st.tokens, e.parentModel, st.isCold, st.ttlMin)
  return { ...out, saving, roundTrip, would: isWorth ? 'hand_back' : 'none' }
}

// A subagent ended: what it spent and which tools it used (agent_end), for the dashboard's plan against
// actual and for measuring the rule against what agents really did
function logAgentEnd($: EngineInterface, id: string, at: number) {
  const a = L.agents[id]
  if (!a || !isEventLogOn()) return
  // Summed per request in the ledger: whole even after old requests were cut
  const u = { input: a.usage.input, output: a.usage.output, cache_read: a.usage.cacheRead, cache_write: a.usage.cacheWrite }
  const tools = a.tools
  void logEvent($, sid, 'agent_end', at, {
    agent_id: id, model: a.model || null, requests: a.requests, usd: usd6(a.usd), ...u,
    tools_web: tools.web, tools_browser: tools.browser, tools_read: tools.read, tools_write: tools.write, tools_other: tools.other,
    duration_ms: a.startedAt ? Math.max(0, at - a.startedAt) : null,
  })
}

// A new session from this one (spec § 4): the fork guard, then model-at-start. Under act one hand-back
// per call at most; a call repeating a handed-back brief, naming a model or saying fresh passes
async function sessionTool(tool: string, $: EngineInterface, e: Record<string, unknown> & { tool_use_id: string }, next: (e: unknown) => Promise<unknown>) {
  const now = await $.clock.now()
  const settings = await read($, settingsA)
  const isHandOff = tool === HAND_OFF
  const context = isHandOff ? 'fork' : e.context === 'fork' ? 'fork' : 'fresh'
  const named = typeof e.model === 'string' ? e.model : ''
  const job = jobKey(String(e.prompt ?? e.remaining_plan ?? e.title ?? ''))
  const parent = mainModel || L.main.model || ''
  const st = await callerState($, undefined, now).catch(() => ({ tokens: null as number | null, isCold: false, ttlMin: 60 }))
  const answering = pending.find(p => p.about !== 'agent' && p.job === job && p.loop === 'main')
  let about: About | null = null
  if (parent && !answering && !handedBack.has('s:' + job) && insists < MAX_INSISTS) {
    if (context === 'fork') { if (st.tokens !== null && forkGuardFires(st.tokens, parent, st.isCold)) about = 'session_fork' }
    else if (!named && isExpensive(parent)) about = 'session_model'
  }
  const isAct = settings.sessionStarts === 'act'
  const line = {
    tool: isHandOff ? 'hand_off' : 'start_session', tool_use_id: e.tool_use_id, initiation: typeof e.initiation === 'string' ? e.initiation : null,
    context, model_named: named || null, effort_named: typeof e.effort === 'string' ? e.effort : null, parent_model: parent || null,
    parent_tokens: st.tokens, cold: st.isCold, job, setting: settings.sessionStarts, would: about ? 'hand_back' : 'none',
  }
  const side: Side = {
    toolUseId: e.tool_use_id, tool: isHandOff ? 'hand_off' : 'start_session', child: null, at: now,
    title: String(e.title ?? e.name ?? '').slice(0, 80), context, named, parentModel: parent,
    about: about === 'session_model' || about === 'session_fork' ? about : null,
    carryUsd: about === 'session_fork' && st.tokens !== null ? forkCarryUsd(st.tokens, parent) : null, result: 'denied',
  }
  const keepSide = () => { x.sides = cap([...x.sides, side], MAX_SIDES) }
  if (about && isAct) {
    keepSide()
    handedBack.add('s:' + job)
    pending.push({ id: e.tool_use_id, job, loop: 'main', about, parent })
    void logEvent($, sid, 'hand_back', now, {
      tool_use_id: e.tool_use_id, about, job, cls: null, parent_model: parent, parent_tokens: st.tokens, cold: st.isCold,
      suggested: about === 'session_fork' ? 'fresh' : SUGGESTED, ratio: about === 'session_model' ? ratioTo(parent) : null,
      carry_usd: about === 'session_fork' && st.tokens !== null ? usd6(forkCarryUsd(st.tokens, parent)) : null,
    })
    void logEvent($, sid, 'side_start', now, { ...line, action: 'hand_back', result: 'denied', child: null })
    await logged()
    return { deny: about === 'session_fork' ? handBackFork(st.tokens ?? 0, parent, isHandOff) : handBackModel(parent) }
  }
  const r = await next(e)
  const res = startResult(r)
  side.result = res.result
  side.child = res.child
  keepSide()
  void logEvent($, sid, 'side_start', now, { ...line, action: answering ? 'passed_after_hand_back' : 'none', result: res.result, child: res.child })
  if (answering) {
    const answer: Answer = answering.about === 'session_fork' ? (context === 'fork' ? 'fork_again' : 'fresh') : answerOf(named, answering.parent)
    logAnswer($, answering, answer, now, { child: res.child, model: named || null })
  }
  await logged()
  return r
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    startEventLog(options?.eventLogFolder)
    try { modVersion = String(JSON.parse(await $.fs.read($.plugin.root + '/.claude-plugin/plugin.json')).version || '') } catch {}
    try {
      const now = await $.clock.now()
      await refresh($)
      await openSession($, String(await $.session.id()), now)
      try { globalSettings = validSettings(await $.store.get('settings')) } catch {}
      try { cwd = await $.session.cwd() } catch {}
      // A subagent model set for the whole session: then no omitted model inherits the parent's
      try { subagentModel = String((await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL')) || '') } catch { subagentModel = '' }
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
        isPaneOpen = true
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
        if (isPaneOpen) await readRecords($)
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

  // A model switch while the cache is warm goes through; a toast names what it re-caches. No 'ask': the
  // desktop app shows no dialog for it and blocks the switch instead (found 2026-11-10)
  on('classic.PreModelSwitch', async ($, e, next) => {
    seenTtl = e.cache_ttl
    const settings = await read($, settingsA)
    const r = await next(e)
    if (!e.prompt_cache_warm || !num(e.estimated_cache_write_usd) || e.estimated_cache_write_usd * (settings.currency === 'eur' ? settings.eurRate : 1) < 0.05) return r
    // Another hook refused or asked: its word stands, and no price for a switch that may not happen
    if (r && r.permissionDecision && r.permissionDecision !== 'allow') return r
    $.ui.toast('Model switch: re-caches ' + k(e.context_tokens) + ' on ' + e.to_model.replace('claude-', '') + ', ' + money(e.estimated_cache_write_usd, settings) + ' at list price')
    return r
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
    await afterCompaction($, r as { tokensBefore?: number; tokensAfter?: number }, sizeBefore, e.trigger)
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
      // A turn nobody typed (the mod's own sending again excepted: it continues one): what the cache is
      // like, and under Act, compact first when it is cold (case B)
      const isOwn = e.origin?.kind === 'plugin' && (e.origin as { name?: string }).name === PANE
      nextWake = isAuto && !isOwn && !e.command ? await wakeAt($, e.origin.kind, !!e.attachments?.length).catch(() => null) : null
      if (nextWake?.act && nextWake.b === 'compact_first') {
        if (COMPACT_FIRST === 'hold-prompt') {
          nextWake.did = 'compact_first'
          isCompactOwed = true
          isOwedByUser = false
          owedCause = 'wake'
          await startCompact($, '', false, 'wake').catch(() => undefined)
        } else {
          // turn.step skips the first request; the text goes again after the compaction. Only the
          // desktop app's <system-reminder> blocks come off; the message's own wrapper stays.
          resendFramed = e.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
        }
      }
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      isWorking = true
      waitingAsks = 0
      const isAuto = isNextTurnAuto
      isNextTurnAuto = false
      isTurnAuto = isAuto
      wake = isAuto ? nextWake : null
      nextWake = null
      firstTokens = null
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
    // A started child's first turn: its brief came from the parent, nobody typed it. Asked once, not
    // awaited here (the request goes on); turn.complete waits for the answer
    if (!e.agentId && e.index === 0 && !wake && childCheck === undefined && s.turns === 0 && !L.main.requests) {
      childCheck = isHeldChild($).then(isChild => {
        if (!isChild || wake) return
        isChildBrief = true
        // No cold dialog for the rest of this turn
        if (isWorking) isTurnAuto = true
      }).catch(() => undefined)
    }
    // Compact-first (case B, the 'skip-turn' form): this turn nobody typed makes no request on the cold
    // cache; the mod compacts after it and sends the text again, framed
    if (wake?.act && wake.b === 'compact_first' && resendFramed && !e.agentId && e.index === 0 && COMPACT_FIRST === 'skip-turn') {
      wake.did = 'compact_first'
      isCompactOwed = true
      isOwedByUser = false
      owedCause = 'wake'
      compactLater($)
      $.ui.log('Token Report: a message nobody typed found the chat cold (' + k(wake.tokens) + '). Compacting first; it goes again right after.')
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
    }
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
      void logCold($, answer === 'Cancel' ? 'cancel' : answer === second && text ? (hasSummary ? 'use_summary' : 'compact_then_send') : 'send')
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
        isOwedByUser = true
        owedCause = 'cold_send'
        compactLater($, resendFocus)
        return skipped
      }
    } else if (!e.agentId && e.index > 0 && !isTurnAuto) {
      // A turn that resumes after a long wait (your answer to a question, a long tool): its next request
      // goes on a cold cache too, and no message of yours passed prompt.submit to ask first. No compact
      // choice here: Claude Code refuses a compaction inside a turn. Cancel ends the turn before the
      // request; what came in (your answer, the tool's result) stays in the chat and goes with your next
      // message. Closing the dialog cancels; with no surface drawing it, the request goes.
      const cold = await coldSend($)
      if (cold) {
        const answer = await $.ui.ask('Your chat went cold while it waited. Going on reloads all ' + cold + '. Go on now?', { header: 'Cold cache', options: ['Send anyway', 'Cancel'] })
          .catch(async () => ((await $.session.surfaces().catch(() => [])).length ? 'Cancel' : 'Send anyway'))
        void logCold($, answer === 'Cancel' ? 'cancel' : 'send')
        if (answer === 'Cancel') {
          $.ui.log('Token Report: stopped before going on, the cache is cold (' + cold + '). Your answer stays in the chat; send any message to go on.')
          return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
        }
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
      if (!e.agentId && e.index === 0) firstTokens = promptOf(toUsage(res.usage))
      if (!e.agentId && model) mainModel = model
      const billing = detectBilling((await read($, settingsA)).billing, usage?.rateLimits, true)
      addRequest(L, { turnId: e.turnId, index: e.index, agentId: e.agentId || null, model, effort: e.effort, startedAt, endedAt, usage: toUsage(res.usage), tools }, mainTtlMin(billing.billing, seenTtl), SUB_TTL_MIN)
      await bump($)
    }
    return res
  })

  // A question to you on the main thread: the turn stays open until you answer (see cacheTick)
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (e.agentId) return next(e)
    waitingAsks += 1
    try {
      return await next(e)
    } finally {
      waitingAsks = Math.max(0, waitingAsks - 1)
    }
  })

  // An Agent call: its effort (agent.spawn has none) and, once it has run, the note for an expensive model
  // named on purpose (decision 1), in the result's `context`, which the model reads after the result
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const id = e.tool_use_id
    if (typeof e.effort === 'string') effortOf.set(id, e.effort)
    try {
      const r = await next(e)
      const note = noteFor.get(id)
      if (note && NOTE_VIA_CONTEXT && r && !r.deny && !r.isError) return { ...r, context: [...(r.context ?? []), note] }
      return r
    } finally {
      noteFor.delete(id)
      effortOf.delete(id)
    }
  })

  // Every agent start, before it runs (spec § 4). Under act a research or gathering agent that would
  // inherit an expensive parent's model goes back to the caller once, with the reason; nothing else is
  // ever refused. Both settings write what act would do.
  on('agent.spawn', async ($, e, next) => {
    const now = await $.clock.now()
    const settings = await read($, settingsA)
    const plan = await planAgent($, e, now).catch(() => null)
    const isAct = settings.agentStarts === 'act'
    if (plan && isAct && plan.would === 'hand_back') {
      handedBack.add(plan.job)
      pending.push({ id: e.tool_use_id, job: plan.job, loop: plan.loop, about: 'agent', parent: e.parentModel })
      void logEvent($, sid, 'hand_back', now, {
        tool_use_id: e.tool_use_id, about: 'agent', job: plan.job, cls: plan.cls, parent_model: e.parentModel, parent_tokens: plan.tokens,
        cold: plan.isCold, suggested: SUGGESTED, ratio: ratioTo(e.parentModel),
        est_saving_usd: plan.saving === null ? null : usd6(plan.saving), round_trip_usd: plan.roundTrip === null ? null : usd6(plan.roundTrip),
      })
      await logged()
      return { deny: handBackAgent(plan.signal, e.parentModel) }
    }
    const r = await next(e)
    const id = r && (r as { agentId?: string }).agentId
    if (id) {
      const model = (r as { model: string }).model
      const type = e.subagentType || 'general-purpose'
      noteAgentStart(L, id, {
        description: e.description, type, model, effort: effortOf.get(e.tool_use_id),
        toolUseId: e.tool_use_id, workflow: !!e.workflow, at: now,
        ...(plan ? { cls: plan.cls, would: plan.would, inherits: plan.inherits, job: plan.job } : {}),
        named: e.model || '', parentModel: e.parentModel, parentAgent: e.parentAgentId || '',
      })
      // What a type with no model named resolves to: next time it is known whether it inherits
      if (!e.model && !e.fork && model) typeModel[type] = model
      if (plan) {
        const isNote = isAct && plan.would === 'note' && !isNoted
        if (isNote) {
          isNoted = true
          noteFor.set(e.tool_use_id, noteExplicit(e.model || model))
        }
        void logEvent($, sid, 'agent_start', now, {
          agent_id: id, tool_use_id: e.tool_use_id, parent_agent_id: e.parentAgentId ?? null, type, cls: plan.cls, signal: plan.signal,
          job: plan.job, model, model_named: e.model ?? null, parent_model: e.parentModel, inherits: plan.inherits,
          effort: effortOf.get(e.tool_use_id) ?? null, fork: e.fork, background: e.background, workflow: !!e.workflow,
          parent_tokens: plan.tokens, setting: settings.agentStarts,
          action: plan.answering ? 'after_hand_back' : isNote ? 'noted' : 'none', would: plan.would,
        })
        if (plan.answering) logAnswer($, plan.answering, answerOf(e.model || '', plan.answering.parent), now, { agent_id: id, model })
      }
      await bump($)
    }
    await logged()
    return r
  })

  on('tool.call', { tool: 'mcp__ccd_session__start_session' } as never, async ($, e, next) => sessionTool(START_SESSION, $, e as never, next as never) as never)
  on('tool.call', { tool: 'mcp__ccd_session__hand_off_to_session' } as never, async ($, e, next) => sessionTool(HAND_OFF, $, e as never, next as never) as never)

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    // A hand-back the caller did not answer before its loop ended
    for (const p of pending.filter(q => q.loop === (e.agentId || 'main'))) logAnswer($, p, 'dropped', now)
    if (e.agentId) {
      noteAgentEnd(L, e.agentId, now)
      logAgentEnd($, e.agentId, now)
      await saveAll($)
      await logged()
      return next(e)
    }
    isWorking = false
    waitingAsks = 0
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
    // The event log: once per session what it runs on (after the first reply, when model and billing
    // are known), then a row per plan limit that moved since the last one written
    if (isEventLogOn()) try {
      // You are back after a pause the Cache Warmer held: it stopped with your message
      if (warm.pause !== lastPromptAt) logWarmStop($, 'message', lastPromptAt)
      if (!isStartLogged && L.main.model) {
        isStartLogged = true
        if (childCheck) await Promise.race([childCheck, new Promise<void>(r => void $.clock.after(5_000, () => r()))])
        const setting = (await read($, settingsA)).billing
        const billing = detectBilling(setting, usage?.rateLimits, L.main.requests > 0).billing
        void logEvent($, sid, 'session_start', now, { model: L.main.model, billing, billing_setting: setting, cache_ttl_min: mainTtlMin(billing, seenTtl), mod_version: modVersion,
          local_id: x.self?.local || null, parent: x.self?.parent || null, profile: (await read($, settingsA)).profile })
      }
      const moved = limitRows(usage?.rateLimits, limitSeen)
      limitSeen = moved.seen
      for (const row of moved.rows) void logEvent($, sid, 'limit', now, row)
      void sampleAppLimits($, now)
    } catch {}
    // The layers (v2 slice 3): a session that never asked who it is (loaded mid-session) asks once
    if (!isSelfAsked && !childCheck) childCheck = isHeldChild($).then(() => undefined).catch(() => undefined)
    if (childCheck) await Promise.race([childCheck, new Promise<void>(r => void $.clock.after(5_000, () => r()))])
    await writeOwnRecord($, now)
    await readRecords($)
    await saveAll($)
    await bump($)
    $.ui.invalidate('ui.render')
    // A turn nobody typed: never a dialog, under Act compact after it above the threshold (case A),
    // and a `wake` line in the event log. A started child's answer is in by now (or never comes)
    // (at most 5 s: a call that hangs costs the line, not the turn)
    if (childCheck) await Promise.race([childCheck, new Promise<void>(r => void $.clock.after(5_000, () => r()))])
    let wk = wake
    wake = null
    if (isChildBrief && !wk) wk = await wakeAt($, 'child_brief', false).catch(() => null)
    isChildBrief = false
    const isAuto = isTurnAuto || !!wk
    const a = await checkTarget($, isAuto, wk).catch(() => null)
    if (wk && a) logWake($, wk, a, now)
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
      isPaneOpen = false
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
