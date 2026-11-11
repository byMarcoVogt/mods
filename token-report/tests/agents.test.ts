import { expect, test } from 'claude-code/testing'

import { agentTable, buildTree, kindOf, ownRecord, standOuts, wouldManagedChange, MAX_DEPTH, type Side, type SideRec } from '../hooks/agents'
import { newLedger, noTools, type Agent } from '../hooks/ledger'

// v2 slice 3 (plan/v2-slice3-agents.md § 3): the tree below a session, actual against Managed's plan,
// and this session's agents by kind. Pure.
const OPUS = 'claude-opus-5-5'
const close = (a: number, b: number) => expect(Math.abs(a - b) < 1e-9).toBe(true)
const agent = (id: string, f: Partial<Agent>): Agent => ({
  id, description: id, type: 'general-purpose', model: OPUS, workflow: false, startedAt: 0, lastRequestAt: 0, requests: 3, tokens: 1000, usd: 1,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, onSonnet: 0.5, tools: noTools(), ...f,
})
const rec = (parent: string, usd: number, onSonnet: number, f: Partial<SideRec> = {}): SideRec =>
  ({ v: 1, parent, title: 't', model: OPUS, usd, onSonnet, agents: {}, sides: [], at: 1, ...f })
const side = (child: string, f: Partial<Side> = {}): Side => ({
  toolUseId: 'tu-' + child, tool: 'start_session', child, at: 1, title: child, context: 'fresh', named: '', parentModel: OPUS, about: null, carryUsd: null, result: 'started', ...f,
})

test('plan: an agent the rule would hand back counts at Sonnet, all others as they ran', () => {
  const t = buildTree('local_me', [agent('a', { would: 'hand_back', usd: 2, onSonnet: 0.8 }), agent('b', { would: 'note', usd: 3 })], [], {})
  close(t.usd, 5)
  close(t.plan, 3.8)
  expect(t.sessions).toBe(0)
})

test('layers: a session with no model counts at its own Sonnet price, a fork less its carry, never below 0', () => {
  const recs = { local_a: rec('local_me', 4, 1.6), local_b: rec('local_me', 1, 0.5), local_c: rec('local_me', 2, 1) }
  const t = buildTree('local_me', [], [side('local_a', { about: 'session_model' }), side('local_b', { about: 'session_fork', context: 'fork', carryUsd: 3 }), side('local_c')], recs)
  expect(t.children.map(n => n.reason)).toEqual(['no model named', 'fork', null])
  close(t.usd, 7)
  close(t.plan, 1.6 + 0 + 2)
})

test('layers: a grandchild rolls up into its parent and the top; a child that never reported has no money', () => {
  const recs = {
    local_a: rec('local_me', 2, 1, { sides: [{ child: 'local_g', about: 'session_model', carry: null }] }),
    local_g: rec('local_a', 3, 1.2),
  }
  const t = buildTree('local_me', [], [side('local_a'), side('local_x')], recs)
  const a = t.children.find(n => n.id === 'local_a')!
  expect(a.children.map(n => n.id)).toEqual(['local_g'])
  close(a.subUsd, 5)
  close(a.subPlan, 2 + 1.2)
  expect(t.notReported).toBe(1)
  expect(t.sessions).toBe(3)
  expect(t.layers).toBe(2)
  close(t.usd, 5)
})

test('layers: a record naming this session as parent shows without a side (a proposal clicked later)', () => {
  const t = buildTree('local_me', [], [side('task_1', { child: 'task_1', result: 'proposed' })], { local_p: rec('local_me', 1, 0.5) })
  expect(t.children.map(n => n.id)).toEqual(['local_p'])
})

test('layers: denied and refused starts draw nothing', () => {
  const t = buildTree('local_me', [], [side('local_a', { result: 'denied', child: null }), side('local_b', { result: 'refused' })], {})
  expect(t.children).toEqual([])
})

test('layers: below MAX_DEPTH sessions fold into their ancestor as "deeper", their money still counts', () => {
  const recs: Record<string, SideRec> = {}
  let parent = 'local_me'
  for (let i = 1; i <= MAX_DEPTH + 2; i++) { recs['local_' + i] = rec(parent, 1, 1); parent = 'local_' + i }
  const t = buildTree('local_me', [], [], recs)
  let n = t.children[0]!
  for (let d = 1; d < MAX_DEPTH; d++) n = n.children[0]!
  expect(n.depth).toBe(MAX_DEPTH)
  expect(n.children).toEqual([])
  expect(n.deeper.n).toBe(2)
  close(t.usd, MAX_DEPTH + 2)
  expect(t.sessions).toBe(MAX_DEPTH + 2)
})

test('layers: a cycle in the records cannot loop', () => {
  const t = buildTree('local_me', [], [side('local_a')], { local_a: rec('local_b', 1, 1, { sides: [{ child: 'local_b', about: null, carry: null }] }), local_b: rec('local_a', 1, 1, { sides: [{ child: 'local_a', about: null, carry: null }] }) })
  close(t.usd, 2)
})

test('record: a session reports its own agents by model and its sides, nothing nested', () => {
  const L = newLedger('s', 0, null)
  L.agents.a = agent('a', { would: 'hand_back', usd: 2, onSonnet: 0.5 })
  L.agents.b = agent('b', { model: 'claude-haiku-5-5', usd: 0.1, onSonnet: 0.3 })
  L.onSonnet = 1.5
  const r = ownRecord(L, 4, { parent: 'local_p', title: 'x' }, [side('local_c', { about: 'session_model' }), side('task_9', { child: 'task_9' })], 7)
  expect(r.agents[OPUS]).toEqual({ n: 1, usd: 2, plan: 0.5 })
  expect(r.agents['claude-haiku-5-5']!.plan).toBe(0.1)
  expect(r.sides).toEqual([{ child: 'local_c', about: 'session_model', carry: null }])
  expect(JSON.stringify(r).length).toBeLessThan(1000)
})

test('kinds: research by named or not; wrote no files only once ended; workflow agents are building', () => {
  expect(kindOf(agent('a', { cls: 'gather' }))).toBe('research_inherited')
  expect(kindOf(agent('a', { cls: 'gather', named: 'opus' }))).toBe('research_named')
  expect(kindOf(agent('a', { cls: 'other' }))).toBe('building')
  expect(kindOf(agent('a', { cls: 'other', endedAt: 5 }))).toBe('no_writes')
  expect(kindOf(agent('a', { cls: 'other', endedAt: 5, tools: { ...noTools(), write: 1 } }))).toBe('building')
  expect(kindOf(agent('a', { cls: 'other', endedAt: 5, workflow: true }))).toBe('building')
})

test('table: cells by model dearest first, Instead only for costly rows', () => {
  const agents = [
    agent('a', { cls: 'gather', would: 'hand_back' }),
    agent('b', { cls: 'gather', model: 'claude-haiku-5-5', usd: 0.02 }),
    agent('c', { cls: 'other', endedAt: 5, model: 'claude-sonnet-5-5' }),
  ]
  const t = agentTable(agents, 'count')
  expect(t.models).toEqual(['Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5'])
  expect(t.rows.map(r => r.kind)).toEqual(['research_inherited', 'no_writes'])
  expect(t.rows[0]!.cells['Opus 5.5']).toEqual({ n: 1, usd: 1 })
  expect(t.rows[0]!.instead).toBe('Managed hands these back to name Sonnet')
  expect(t.rows[1]!.instead).toBe('')
  expect(agentTable(agents, 'act').rows[0]!.instead).toBe('handed back')
})

test('stand-outs: a quarter and $0.50, or $0.50 off plan; three at most', () => {
  const many = Array.from({ length: 6 }, (_, i) => agent('a' + i, { usd: 0.2 }))
  expect(standOuts(many)).toEqual([])
  expect(standOuts([...many, agent('big', { usd: 3 })]).map(a => a.id)).toEqual(['big'])
  expect(standOuts([agent('x', { usd: 0.6, would: 'hand_back', onSonnet: 0.05 }), ...many]).map(a => a.id)).toEqual(['x'])
  expect(standOuts(Array.from({ length: 5 }, (_, i) => agent('h' + i, { usd: 1, would: 'hand_back', onSonnet: 0.1 }))).length).toBe(3)
})

test('the page offers Managed only when it would change something', () => {
  const empty = buildTree('', [], [], {})
  expect(wouldManagedChange([agent('a', { would: 'none' })], empty)).toBe(false)
  expect(wouldManagedChange([agent('a', { would: 'hand_back' })], empty)).toBe(true)
  expect(wouldManagedChange([], buildTree('local_me', [], [side('local_a', { about: 'session_model' })], { local_a: rec('local_me', 1, 0.5) }))).toBe(true)
})
