// token-report ledger: one source for every number. Pure functions over plain data, so they test
// without the engine. register.tsx feeds it events; the band and the Settings pane read from it.
// Nothing here touches `$`.

// ---- Prices -------------------------------------------------------------------------------
// USD per million tokens, Anthropic's list prices (checked 2026-10-28). Haiku 5.5: 0.10 / 0.50 up to a
// 100k prompt, 0.50 / 2.50 beyond; its cache rates are derived from the standard multipliers (read 0.1×,
// write 1.25× for 5 min, 2× for 1 h), marked `derived`. Update the table when prices change.
export type Price = { input: number; output: number; cacheRead: number; write5m: number; write1h: number; derived?: boolean }
const PRICES: Record<string, Price> = {
  'claude-opus-5-5':   { input: 4,  output: 20, cacheRead: 0.20, write5m: 5,     write1h: 8 },
  'claude-sonnet-5-5': { input: 2,  output: 10, cacheRead: 0.10, write5m: 2.5,   write1h: 4 },   // read 0.05× (prompt-caching docs, checked 2026-10-28)
  'claude-fable-5-1':  { input: 10, output: 50, cacheRead: 0.25, write5m: 12.5,  write1h: 20 },
  'claude-haiku-4-5':  { input: 1,  output: 5,  cacheRead: 0.10, write5m: 1.25,  write1h: 2 },
}
const derived = (input: number, output: number): Price =>
  ({ input, output, cacheRead: input * 0.1, write5m: input * 1.25, write1h: input * 2, derived: true })
const HAIKU_55 = derived(0.1, 0.5), HAIKU_55_LONG = derived(0.5, 2.5)
const FALLBACK = 'claude-opus-5-5'

// The price of the model that answered. An id the table doesn't know (a new or older model, a
// gateway's alias) takes its family's current price, and only an id with no family name Opus 5.5's.
// Session totals don't depend on this: they come from Claude Code's own figure (sessionUsd).
export function priceFor(model: string | null | undefined, promptTokens = 0): Price {
  const id = typeof model === 'string' ? model.toLowerCase() : ''
  const haiku = () => (promptTokens > 100_000 ? HAIKU_55_LONG : HAIKU_55)
  if (id.includes('claude-haiku-5-5')) return haiku()
  const exact = Object.keys(PRICES).find(key => id.includes(key))
  if (exact) return PRICES[exact]!
  if (id.includes('haiku')) return haiku()
  if (id.includes('sonnet')) return PRICES['claude-sonnet-5-5']!
  if (id.includes('fable') || id.includes('mythos')) return PRICES['claude-fable-5-1']!
  return PRICES[FALLBACK]!
}

// Euros: the fallback rate until the ECB rate arrives (2026 so far averages about 0.86 € per $)
export const EUR_PER_USD = 0.86

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type Ttl = '5m' | '1h'
const num = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const n0 = (n: unknown) => (num(n) ? n : 0)

// The engine's ModelUsage (or TurnUsage) as four plain counts
export function toUsage(u: unknown): Usage {
  const r = (u || {}) as Record<string, unknown>
  return { input: n0(r.input_tokens), output: n0(r.output_tokens), cacheRead: n0(r.cache_read_input_tokens), cacheWrite: n0(r.cache_creation_input_tokens) }
}
export const promptOf = (u: Usage) => u.input + u.cacheRead + u.cacheWrite
export const tokensOf = (u: Usage) => promptOf(u) + u.output
export const ttlOf = (minutes: number): Ttl => (minutes >= 60 ? '1h' : '5m')

// What one request cost, split by token kind
export type Parts = { input: number; output: number; read: number; write: number }
export const noParts = (): Parts => ({ input: 0, output: 0, read: 0, write: 0 })
export function partsOf(u: Usage, model: string | null | undefined, ttl: Ttl): Parts {
  const p = priceFor(model, promptOf(u))
  return { input: u.input * p.input / 1e6, output: u.output * p.output / 1e6, read: u.cacheRead * p.cacheRead / 1e6, write: u.cacheWrite * (ttl === '1h' ? p.write1h : p.write5m) / 1e6 }
}
export const sumParts = (p: Parts) => p.input + p.output + p.read + p.write
// What rewriting `tokens` of prompt into the cache costs on `model`
export const rewriteUsd = (tokens: number, model: string | null | undefined, ttl: Ttl) =>
  (tokens * (ttl === '1h' ? priceFor(model, tokens).write1h : priceFor(model, tokens).write5m)) / 1e6

// ---- Billing and cache lifetime ------------------------------------------------------------
// Claude Code gives the main thread the 1-hour cache only on a subscription within plan usage; an API
// key, usage credits or a cloud provider get 5 minutes (code.claude.com/docs/en/prompt-caching, 2026-10-28).
// The 5-hour / weekly limits arrive only for subscribers, after the first reply: their presence is the
// signal. `override` is the Settings switch; a model-switch event's `cache_ttl` beats both when seen.
export type Billing = 'subscription' | 'api' | 'unknown'
export function detectBilling(override: 'auto' | 'subscription' | 'api', limits: { kind: string }[] | undefined, hasReplied: boolean): { billing: Billing; why: string } {
  if (override !== 'auto') return { billing: override, why: 'set in Settings' }
  const plan = (limits || []).some(l => l && (l.kind === 'five_hour' || l.kind === 'seven_day'))
  if (plan) return { billing: 'subscription', why: '5-hour / weekly limits reported' }
  if (hasReplied) return { billing: 'api', why: 'no plan limits after the first reply' }
  return { billing: 'unknown', why: 'waiting for the first reply' }
}
export function mainTtlMin(billing: Billing, seenTtl: Ttl | null): number {
  if (seenTtl) return seenTtl === '1h' ? 60 : 5
  return billing === 'api' ? 5 : 60
}

// ---- Requests, agents, the main thread ------------------------------------------------------
export const COLD_SHARE = 0.5, COLD_MIN = 20_000
// A request that wrote more than half its prompt (and 20k+) to the cache was a rewrite
export const isRewrite = (u: Usage) => u.cacheWrite >= COLD_MIN && u.cacheWrite > promptOf(u) * COLD_SHARE

export type Req = {
  turnId: string; index: number; agentId: string | null; model: string; effort?: string | number
  startedAt: number; endedAt: number; usage: Usage; tools: string[]; usd: number; rewrite: boolean
}
export type Agent = {
  id: string; description: string; type: string; model: string; effort?: string | number
  toolUseId?: string; row?: string; workflow: boolean; turn?: string   // the main turn that started it
  startedAt: number; endedAt?: number; lastRequestAt: number
  requests: number; tokens: number; usd: number
  first?: { read: number; wrote: number }; lastTool?: string
}
export type Ledger = {
  v: 1; sid: string; since: number; engineUsdAtStart: number | null
  requests: Req[]; folded: { usd: number; n: number }
  agents: Record<string, Agent>
  main: { usd: number; requests: number; lastRequestAt: number; model: string | null; rewrites: { count: number; tokens: number; usd: number } }
  parts: { main: Parts; agents: Parts }
  turns: Record<string, TurnSum>          // main turns, the last MAX_TURNS
  currentTurn: string | null
}
// One main turn: when it started, what the main thread spent, what the agents it started spent
export type TurnSum = { at: number; usd: number; agentsUsd: number; agents: number; rewrites: number }
export const MAX_TURNS = 200
export const MAX_REQUESTS = 2000, SNAPSHOT_REQUESTS = 200

export function newLedger(sid: string, since: number, engineUsd: number | null): Ledger {
  return { v: 1, sid, since, engineUsdAtStart: num(engineUsd) ? engineUsd : null, requests: [], folded: { usd: 0, n: 0 }, agents: {},
    main: { usd: 0, requests: 0, lastRequestAt: 0, model: null, rewrites: { count: 0, tokens: 0, usd: 0 } },
    parts: { main: noParts(), agents: noParts() }, turns: {}, currentTurn: null }
}

export type AgentMeta = { description?: string; type?: string; model?: string; effort?: string | number; toolUseId?: string; row?: string; workflow?: boolean; turn?: string; at: number }
export function noteAgentStart(L: Ledger, id: string, m: AgentMeta): Agent {
  const old = L.agents[id]
  const a: Agent = old || { id, description: '', type: 'agent', model: '', workflow: false, startedAt: m.at, lastRequestAt: 0, requests: 0, tokens: 0, usd: 0 }
  if (m.description) a.description = m.description
  if (m.type) a.type = m.type
  if (m.model) a.model = m.model
  if (m.effort !== undefined) a.effort = m.effort
  if (m.toolUseId) a.toolUseId = m.toolUseId
  if (m.row) a.row = m.row
  if (m.workflow !== undefined) a.workflow = m.workflow
  if (!old) {
    const turn = m.turn || L.currentTurn || undefined
    if (turn) { a.turn = turn; if (L.turns[turn]) L.turns[turn].agents += 1 }
  }
  L.agents[id] = a
  return a
}
export function noteAgentEnd(L: Ledger, id: string, at: number) {
  if (L.agents[id]) L.agents[id].endedAt = at
}

// One model request, from turn.step. Main-thread writes at the main TTL, sub-agents at theirs.
export function addRequest(L: Ledger, r: Omit<Req, 'usd' | 'rewrite'>, ttlMainMin: number, ttlSubMin: number): Req {
  const ttl = ttlOf(r.agentId ? ttlSubMin : ttlMainMin)
  const parts = partsOf(r.usage, r.model, ttl)
  const req: Req = { ...r, usd: sumParts(parts), rewrite: isRewrite(r.usage) }
  const into = L.parts[r.agentId ? 'agents' : 'main']
  into.input += parts.input; into.output += parts.output; into.read += parts.read; into.write += parts.write
  L.requests.push(req)
  if (L.requests.length > MAX_REQUESTS) {
    const old = L.requests.splice(0, L.requests.length - MAX_REQUESTS)
    for (const o of old) { L.folded.usd += o.usd; L.folded.n += 1 }
  }
  if (r.agentId) {
    const a = L.agents[r.agentId] || noteAgentStart(L, r.agentId, { model: r.model, workflow: true, type: 'workflow agent', at: r.startedAt })
    if (!a.first) a.first = { read: r.usage.cacheRead, wrote: r.usage.cacheWrite }
    a.requests += 1
    a.tokens += tokensOf(r.usage)
    a.usd += req.usd
    a.lastRequestAt = Math.max(a.lastRequestAt, r.startedAt)
    if (r.tools.length) a.lastTool = r.tools[r.tools.length - 1]
    if (!a.model) a.model = r.model
    if (a.turn && L.turns[a.turn]) L.turns[a.turn]!.agentsUsd += req.usd
  } else {
    let t = L.turns[r.turnId]
    if (!t) {
      t = L.turns[r.turnId] = { at: r.startedAt, usd: 0, agentsUsd: 0, agents: 0, rewrites: 0 }
      const ids = Object.keys(L.turns)
      if (ids.length > MAX_TURNS) for (const id of ids.slice(0, ids.length - MAX_TURNS)) delete L.turns[id]
    }
    t.usd += req.usd
    if (req.rewrite) t.rewrites += 1
    L.currentTurn = r.turnId
    L.main.usd += req.usd
    L.main.requests += 1
    L.main.lastRequestAt = Math.max(L.main.lastRequestAt, r.startedAt)
    L.main.model = r.model
    if (req.rewrite) {
      L.main.rewrites.count += 1
      L.main.rewrites.tokens += r.usage.cacheWrite
      L.main.rewrites.usd += rewriteUsd(r.usage.cacheWrite, r.model, ttl)
    }
  }
  return req
}

export const agentsUsd = (L: Ledger) => Object.values(L.agents).reduce((s, a) => s + a.usd, 0)
export const ledgerUsd = (L: Ledger) => L.main.usd + agentsUsd(L)
// The whole session's cost: Claude Code's own list-price figure when it has one (it counts from the
// session's start; the ledger only from when this mod loaded), else what Claude Code had counted when
// the ledger started plus the ledger since.
export function sessionUsd(L: Ledger, engineUsdNow: number | null | undefined): number {
  if (num(engineUsdNow) && engineUsdNow >= ledgerUsd(L) * 0.5) return engineUsdNow
  return (L.engineUsdAtStart ?? 0) + ledgerUsd(L)
}

// Minutes left on a cache clock that started at the last request's start, or null before any
export function clockLeft(lastRequestAt: number, ttlMin: number, now: number): number | null {
  if (!num(lastRequestAt) || lastRequestAt <= 0 || !num(now)) return null
  return ttlMin - (now - lastRequestAt) / 60_000
}

// A compact copy for $.store (a hot reload rebuilds from it); restore() rejects anything else
export function snapshot(L: Ledger): Ledger {
  const keep = L.requests.slice(-SNAPSHOT_REQUESTS)
  const dropped = L.requests.slice(0, L.requests.length - keep.length)
  return { ...L, requests: keep, folded: { usd: L.folded.usd + dropped.reduce((s, r) => s + r.usd, 0), n: L.folded.n + dropped.length } }
}
export function restore(saved: unknown): Ledger | null {
  const s = saved as Ledger
  if (!s || typeof s !== 'object' || s.v !== 1 || typeof s.sid !== 'string' || !Array.isArray(s.requests)) return null
  if (!s.main || !num(s.main.usd) || !s.agents || typeof s.agents !== 'object' || !s.folded || !num(s.folded.usd)) return null
  // fields a ledger stored by an older build may lack
  if (!s.parts || !s.parts.main || !s.parts.agents) s.parts = { main: noParts(), agents: noParts() }
  if (!s.turns || typeof s.turns !== 'object') s.turns = {}
  if (s.currentTurn === undefined) s.currentTurn = null
  return s
}
