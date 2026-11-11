// token-report agents view (v2 slice 3, plan/v2-slice3-agents.md § 3): what this session and the sessions
// below it started, actual against Managed's plan. Pure, like ledger.ts: register.tsx feeds it, the
// Agents page draws it, the tests call it.
//
// The plan is Managed's rule with every hand-back followed and the same steps: an agent slice 2 would
// hand back counts at its requests priced on Sonnet; a session started with no model counts at its own
// requests on Sonnet; a fork at its cost less what it carried over a fresh start; all else as it ran.
import { isExpensive } from './router'
import { priceFor, type Agent, type Ledger } from './ledger'

// ---- a session's own record, written by each started session (store key `side:<local id>`) ------------
export type About = 'session_model' | 'session_fork'
export type SideRec = {
  v: 1
  parent: string
  title: string
  model: string
  // The whole session at list price (main and its own agents), and the same requests on Sonnet
  usd: number
  onSonnet: number
  // Its own agents by model: count, actual, plan (the agent rule)
  agents: Record<string, { n: number; usd: number; plan: number }>
  // The sessions it started, with what the rule said about each
  sides: { child: string; about: About | null; carry: number | null }[]
  at: number
}
export const SIDE_KEY = 'side:'
const num = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

// A session started from this one, as the call went (kept live in register's Extra)
export type Side = {
  toolUseId: string
  tool: 'start_session' | 'hand_off'
  child: string | null
  at: number
  title: string
  context: 'fresh' | 'fork'
  named: string
  parentModel: string
  about: About | null
  carryUsd: number | null
  result: 'started' | 'proposed' | 'refused' | 'denied'
}
export const MAX_SIDES = 50

export const agentPlan = (a: Agent) => (a.would === 'hand_back' && num(a.onSonnet) ? a.onSonnet : a.usd)

export function ownRecord(L: Ledger, usd: number, self: { parent: string; title: string }, sides: Side[], at: number): SideRec {
  const agents: SideRec['agents'] = {}
  for (const a of Object.values(L.agents)) {
    const m = a.model || '?'
    const row = agents[m] || (agents[m] = { n: 0, usd: 0, plan: 0 })
    row.n += 1
    row.usd += a.usd
    row.plan += agentPlan(a)
  }
  return {
    v: 1, parent: self.parent, title: self.title.slice(0, 80), model: L.main.model || '', usd, onSonnet: L.onSonnet || 0, agents,
    sides: sides.filter(s => s.child && s.child.startsWith('local_')).map(s => ({ child: s.child!, about: s.about, carry: s.carryUsd })),
    at,
  }
}
// A record read back from the store, or null when it is not one (another version, a damaged value)
export function asRecord(v: unknown): SideRec | null {
  const r = v as SideRec
  if (!r || typeof r !== 'object' || r.v !== 1 || typeof r.parent !== 'string' || !num(r.usd) || !num(r.onSonnet)) return null
  if (!r.agents || typeof r.agents !== 'object' || !Array.isArray(r.sides)) return null
  return r
}

// ---- the tree below this session --------------------------------------------------------------------
export const MAX_DEPTH = 3
export type Node = {
  id: string
  title: string
  model: string
  depth: number
  // false: no record came (never loaded this version, older than the store keeps, another machine,
  // still on its first turn); then every number below is 0 and the line says "not reported"
  reported: boolean
  usd: number
  plan: number
  agents: { n: number; usd: number; plan: number }
  // This node and everything below it
  subUsd: number
  subPlan: number
  // Why the plan differs here: the rule's word, or null
  reason: 'no model named' | 'fork' | 'research inherited' | null
  // Sessions below MAX_DEPTH, folded into this node
  deeper: { n: number; usd: number; plan: number }
  children: Node[]
  at: number
}
export type Tree = {
  // This session's own agents (the top line)
  own: { n: number; usd: number; plan: number }
  children: Node[]
  usd: number
  plan: number
  sessions: number
  notReported: number
  layers: number
}

type Edge = { child: string; about: About | null; carry: number | null; title?: string; model?: string; at?: number }

function nodeOf(edge: Edge, depth: number, recs: Record<string, SideRec>, seen: Set<string>): Node {
  seen.add(edge.child)
  const rec = recs[edge.child]
  const agents = { n: 0, usd: 0, plan: 0 }
  if (rec) for (const a of Object.values(rec.agents)) { agents.n += a.n; agents.usd += a.usd; agents.plan += a.plan }
  let usd = 0, plan = 0
  let reason: Node['reason'] = null
  if (rec) {
    usd = rec.usd
    if (edge.about === 'session_model') { plan = rec.onSonnet; reason = 'no model named' }
    else if (edge.about === 'session_fork') { plan = Math.max(0, rec.usd - (edge.carry ?? 0)); reason = 'fork' }
    else { plan = rec.usd - agents.usd + agents.plan; if (agents.plan < agents.usd - 1e-9) reason = 'research inherited' }
  }
  const node: Node = {
    id: edge.child, title: (rec?.title || edge.title || '').trim() || 'Session', model: rec?.model || edge.model || '', depth,
    reported: !!rec, usd, plan, agents, subUsd: usd, subPlan: plan, reason, deeper: { n: 0, usd: 0, plan: 0 }, children: [], at: edge.at ?? rec?.at ?? 0,
  }
  for (const e of edgesBelow(edge.child, rec, recs, seen)) {
    const c = nodeOf(e, depth + 1, recs, seen)
    node.subUsd += c.subUsd
    node.subPlan += c.subPlan
    if (depth + 1 > MAX_DEPTH) {
      node.deeper.n += 1 + c.deeper.n + countBelow(c)
      node.deeper.usd += c.subUsd
      node.deeper.plan += c.subPlan
    } else node.children.push(c)
  }
  // Below the cut nothing is drawn: its own children were folded into it above
  if (depth >= MAX_DEPTH) node.children = []
  node.children.sort((a, b) => a.at - b.at)
  return node
}
const countBelow = (n: Node): number => n.children.reduce((s, c) => s + 1 + countBelow(c), 0)

// A session's children: those its record names, then any record that names it as parent (a proposal
// clicked later, a hand-off whose result gave no id). Each id once.
function edgesBelow(id: string, rec: SideRec | undefined, recs: Record<string, SideRec>, seen: Set<string>): Edge[] {
  const out: Edge[] = []
  const has = new Set<string>()
  for (const s of rec?.sides ?? []) if (!seen.has(s.child) && !has.has(s.child)) { has.add(s.child); out.push({ ...s }) }
  for (const [child, r] of Object.entries(recs)) if (r.parent === id && !seen.has(child) && !has.has(child)) { has.add(child); out.push({ child, about: null, carry: null }) }
  return out
}

export function buildTree(self: string, agents: Agent[], sides: Side[], recs: Record<string, SideRec>): Tree {
  const own = { n: 0, usd: 0, plan: 0 }
  for (const a of agents) { own.n += 1; own.usd += a.usd; own.plan += agentPlan(a) }
  const seen = new Set<string>(self ? [self] : [])
  const edges: Edge[] = []
  const has = new Set<string>()
  for (const s of sides) {
    if (s.result === 'denied' || s.result === 'refused') continue
    // A proposal (task_…) has no session until it is clicked; it then shows through its record's parent
    if (!s.child || !s.child.startsWith('local_')) continue
    if (has.has(s.child)) continue
    has.add(s.child)
    edges.push({ child: s.child, about: s.about, carry: s.carryUsd, title: s.title, model: s.named || s.parentModel, at: s.at })
  }
  if (self) for (const [child, r] of Object.entries(recs)) if (r.parent === self && !has.has(child)) { has.add(child); edges.push({ child, about: null, carry: null }) }
  const children = edges.map(e => nodeOf(e, 1, recs, seen)).sort((a, b) => a.at - b.at)
  let usd = own.usd, plan = own.plan, sessions = 0, notReported = 0, layers = children.length ? 1 : 0
  const walk = (n: Node) => {
    sessions += 1 + n.deeper.n
    if (!n.reported) notReported += 1
    layers = Math.max(layers, n.depth + (n.deeper.n ? 1 : 0))
    n.children.forEach(walk)
  }
  for (const c of children) { usd += c.subUsd; plan += c.subPlan; walk(c) }
  return { own, children, usd, plan, sessions, notReported, layers }
}

// ---- this session's own agents, by kind and model ---------------------------------------------------
export type Kind = 'research_inherited' | 'research_named' | 'no_writes' | 'building'
export const KIND_LABEL: Record<Kind, string> = {
  research_inherited: 'Research, no model named', research_named: 'Research, named', no_writes: 'Wrote no files', building: 'Building and other',
}
export function kindOf(a: Agent): Kind {
  if (a.cls === 'gather') return a.named ? 'research_named' : 'research_inherited'
  if (!a.workflow && a.endedAt !== undefined && a.tools && a.tools.write === 0 && a.requests > 0) return 'no_writes'
  return 'building'
}
// "claude-opus-5-5" → "Opus 5.5"
export function shortModel(id: string): string {
  const m = /(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/i.exec(id)
  if (m) return m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase() + ' ' + m[2] + (m[3] ? '.' + m[3] : '')
  return id ? id.replace(/^claude-/, '') : '?'
}

export type KindRow = { kind: Kind; label: string; cells: Record<string, { n: number; usd: number }>; usd: number; plan: number; handBacks: number; instead: string }
export type AgentTable = { models: string[]; rows: KindRow[] }
export function agentTable(agents: Agent[], agentStarts: 'count' | 'act'): AgentTable {
  const rows = new Map<Kind, KindRow>()
  const models = new Set<string>()
  for (const a of agents) {
    const kind = kindOf(a)
    const m = shortModel(a.model)
    models.add(m)
    const row = rows.get(kind) || { kind, label: KIND_LABEL[kind], cells: {}, usd: 0, plan: 0, handBacks: 0, instead: '' }
    const cell = row.cells[m] || (row.cells[m] = { n: 0, usd: 0 })
    cell.n += 1
    cell.usd += a.usd
    row.usd += a.usd
    row.plan += agentPlan(a)
    if (a.would === 'hand_back') row.handBacks += 1
    rows.set(kind, row)
  }
  const isCostly = (k: Kind) => agents.some(a => kindOf(a) === k && isExpensive(a.model) && a.usd > 0)
  for (const row of rows.values()) {
    if (!isCostly(row.kind)) continue
    if (row.kind === 'research_inherited' && row.handBacks) row.instead = agentStarts === 'act' ? 'handed back' : 'Managed hands these back to name Sonnet'
    if (row.kind === 'research_named') row.instead = 'named on purpose; Managed notes it once'
    if (row.kind === 'no_writes') row.instead = 'no rule sees these before the start: name a model in the brief'
  }
  const order: Kind[] = ['research_inherited', 'research_named', 'no_writes', 'building']
  // Models ordered by price, dearest first
  const byPrice = [...models].sort((a, b) => priceFor(idOf(b)).input - priceFor(idOf(a)).input || a.localeCompare(b))
  return { models: byPrice, rows: order.map(k => rows.get(k)).filter((r): r is KindRow => !!r) }
}
const idOf = (short: string) => 'claude-' + short.toLowerCase().replace(' ', '-').replace('.', '-')

// At most three single agents worth a line: a quarter of this session's agents and $0.50, or $0.50 off plan
export function standOuts(agents: Agent[]): Agent[] {
  const total = agents.reduce((s, a) => s + a.usd, 0)
  return agents
    .filter(a => (a.usd >= 0.25 * total && a.usd >= 0.5) || a.usd - agentPlan(a) >= 0.5)
    .sort((a, b) => b.usd - a.usd)
    .slice(0, 3)
}

// Would Managed change anything here? (the page's one button shows only then)
export const wouldManagedChange = (agents: Agent[], tree: Tree) =>
  agents.some(a => a.would === 'hand_back') || tree.children.some(function any(n: Node): boolean { return n.reason === 'no model named' || n.reason === 'fork' || n.children.some(any) })
