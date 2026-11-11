import { expect, mock, test } from 'claude-code/testing'

import { eventsIdle } from '../hooks/events'
import { api, setup } from './harness'

// v2 slice 2 (plan/v2-slice2-router.md): agent and session starts. "Agent starts" and "Session starts":
// count (default) · act. Act hands a start back to the calling model once (a deny it reads), never a
// dialog. Every start writes a line saying what act would do.
const ON = { options: { eventLogFolder: '~/.claude/data-lake/token-report' } }
const SLOW = { timeoutMs: 60_000, ...ON }
const START = Date.UTC(2026, 10, 10, 9, 0, 0)
const FILE = 'C:/Users/Test/.claude/data-lake/token-report/events-2026-11.jsonl'
const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5-5'
const START_SESSION = 'mcp__ccd_session__start_session'
const HAND_OFF = 'mcp__ccd_session__hand_off_to_session'
const ALIAS: Record<string, string> = { sonnet: SONNET, opus: OPUS, haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-1' }

type Opts = { settings?: Record<string, unknown>; tokens?: number; model?: string; resolve?: Record<string, string> }

async function world($: any, on: any, opts: Opts = {}) {
  // Core's answers, registered before the harness's catch-alls: an agent runs on the model named, else
  // on its type's own (resolve), else on the parent's
  let n = 0
  // The Agent tool's result is the launch (a background agent's). The test raises the start itself
  // (agent below): the test engine refuses a $.agent.spawn from inside a test's own answer
  on('tool.call', { tool: 'Agent' }, async () => ({ result: { status: 'async_launched' } }))
  const starts: any[] = []
  const started = async (_$: unknown, e: any) => {
    starts.push(e)
    return { result: 'Started session "x" (session_id: local_abc-' + starts.length + ', name: x)' }
  }
  on('tool.call', { tool: START_SESSION }, started)
  on('tool.call', { tool: HAND_OFF }, started)
  const asked: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, async (_$: unknown, e: any) => { asked.push('ask'); return { result: { questions: e.questions, answers: {} } } })
  const t = setup($, on, START)
  t.env.spawn = (e: any) => ({ model: e.model ? ALIAS[e.model] ?? e.model : opts.resolve?.[e.subagentType] ?? e.parentModel, agentId: 'ag' + ++n })
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
  on('turn.start', async (_$: unknown, e: unknown) => e as never)
  on('prompt.submit', async (_$: unknown, e: any) => ({ text: e.text }))
  t.store['settings'] = { billing: 'subscription', away: 'keep', coldAsk: 'off', contextTarget: 400_000, atTarget: 'off', ...opts.settings }
  t.env.tokens = opts.tokens ?? 200_000
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as never)
  let turnN = 0
  let turnId = ''
  // A person's main turn is open: its first request read the context (on the parent's model)
  const open = async () => {
    turnId = 't' + ++turnN
    await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } } as never)
    await $.turn.start({ turnId, text: 'go' } as never)
    const tok = t.env.tokens ?? 0
    await t.step({ turnId, model: opts.model ?? OPUS }, api(tok, 0, opts.model ?? OPUS))
  }
  const close = async () => {
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId })
    await eventsIdle()
  }
  let callN = 0
  // An Agent call as the model makes it
  // An Agent call as the model makes it: the start (agent.spawn), then the tool's result (tool.call),
  // where a note rides along
  const agent = async (fields: Record<string, unknown>) => {
    const call = { tool: 'Agent', tool_use_id: 'tu' + ++callN, description: 'Web research: ski resorts', prompt: 'Find prices for ski passes in Tirol.', subagent_type: 'general-purpose', ...fields } as any
    const sp = await $.agent.spawn({ tool_use_id: call.tool_use_id, prompt: call.prompt, description: call.description, subagentType: call.subagent_type, ...(call.model ? { model: call.model } : {}), background: true, provider: 'firstParty', parentModel: opts.model ?? OPUS, fork: false } as never)
    await eventsIdle()
    if (sp.deny) return { deny: sp.deny } as any
    const r = await $.tool.call(call)
    await eventsIdle()
    return r
  }
  const session = async (tool: string, fields: Record<string, unknown>) => {
    const r = await $.tool.call({ tool, tool_use_id: 'ts' + ++callN, initiation: 'user_asked', title: 'x', prompt: 'Build the export page.', context: 'fresh', ...fields })
    await eventsIdle()
    return r
  }
  const rows = (kind?: string) =>
    (files.get(FILE) || '').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>).filter(r => !kind || r.kind === kind)
  return { t, asked, starts, open, close, agent, session, rows, files }
}

test('count: a gathering start on an Opus parent starts; agent_start says act would hand it back', SLOW, async ($, on) => {
  const w = await world($, on)
  await w.open()
  const r = await w.agent({})
  expect(r.deny).toBeUndefined()
  const line = w.rows('agent_start')[0]!
  expect(line).toMatchObject({ cls: 'gather', signal: 'words', model: OPUS, model_named: null, parent_model: OPUS, inherits: true, setting: 'count', action: 'none', would: 'hand_back', parent_tokens: 200_002 })
  expect(String(line.job)).toMatch(/^[0-9a-f]{8}$/)
  expect(w.rows('hand_back').length).toBe(0)
  // No prompt text in the log
  expect(w.files.get(FILE)).not.toContain('ski')
})

test('act: handed back with the reason; a re-issue on sonnet starts and answers cheaper', SLOW, async ($, on) => {
  const w = await world($, on, { settings: { agentStarts: 'act' } })
  await w.open()
  const r = await w.agent({})
  expect(String(r.deny)).toContain('Token Report (Managed): this agent was not started')
  expect(String(r.deny)).toContain('model: "sonnet"')
  expect(w.rows('hand_back')[0]).toMatchObject({ tool_use_id: 'tu1', about: 'agent', cls: 'gather', parent_model: OPUS, suggested: 'sonnet', ratio: 0.5, cold: false })
  expect(w.rows('agent_start').length).toBe(0)
  const again = await w.agent({ model: 'sonnet' })
  expect(again.deny).toBeUndefined()
  expect(w.rows('agent_start')[0]).toMatchObject({ model: SONNET, model_named: 'sonnet', action: 'after_hand_back' })
  expect(w.rows('hand_back_answer')[0]).toMatchObject({ hand_back_id: 'tu1', answer: 'cheaper', model: SONNET })
})

test('act: a re-issue naming opus starts (same_model); unanswered by the turn\'s end: dropped', SLOW, async ($, on) => {
  const w = await world($, on, { settings: { agentStarts: 'act' } })
  await w.open()
  await w.agent({})
  const again = await w.agent({ model: 'opus' })
  expect(again.deny).toBeUndefined()
  expect(w.rows('hand_back_answer')[0]).toMatchObject({ answer: 'same_model' })
  await w.agent({ prompt: 'Search the web for snow reports.' })
  await w.close()
  expect(w.rows('hand_back_answer')[1]).toMatchObject({ answer: 'dropped', agent_id: null })
})

test('act: one job is never handed back twice; after three insists no more hand-backs this session', SLOW, async ($, on) => {
  const w = await world($, on, { settings: { agentStarts: 'act' } })
  await w.open()
  expect((await w.agent({})).deny).toBeTruthy()
  // The same prompt again, no model named: it passes (the caller insists)
  expect((await w.agent({})).deny).toBeUndefined()
  for (const p of ['Search A', 'Search B']) {
    expect((await w.agent({ prompt: p })).deny).toBeTruthy()
    expect((await w.agent({ prompt: p, model: 'opus' })).deny).toBeUndefined()
  }
  // Three insists: a new gathering job starts unasked, act's line says it would have
  const r = await w.agent({ prompt: 'Search C' })
  expect(r.deny).toBeUndefined()
  expect(w.rows('hand_back').length).toBe(3)
})

test('act: an expensive model named on purpose starts, with one note per session', SLOW, async ($, on) => {
  const w = await world($, on, { settings: { agentStarts: 'act' } })
  await w.open()
  const r = await w.agent({ model: 'opus' })
  expect(r.deny).toBeUndefined()
  expect((r.context ?? []).join(' ')).toContain('by explicit choice')
  expect(w.rows('agent_start')[0]).toMatchObject({ action: 'noted', would: 'note' })
  const r2 = await w.agent({ model: 'opus', prompt: 'Search again' })
  expect(r2.context ?? []).toEqual([])
  expect(w.rows('agent_start')[1]).toMatchObject({ action: 'none', would: 'note' })
})

test('act: never on a Sonnet parent, a builder, a workflow, a resume, a teammate or a fork', SLOW, async ($, on) => {
  const w = await world($, on, { settings: { agentStarts: 'act' } })
  await w.open()
  expect((await w.agent({ description: 'Implement the export', prompt: 'Build it.' })).deny).toBeUndefined()
  const base = { prompt: 'Search the web', description: 'Web research', subagentType: 'general-purpose', background: false, provider: 'firstParty', parentModel: OPUS, fork: false }
  for (const extra of [{ workflow: { runId: 'wf_1', agentIndex: 1 } }, { resume: { agentId: 'ag9' } }, { isTeammate: true }, { fork: true, subagentType: 'fork' }]) {
    const r = await $.agent.spawn({ tool_use_id: 'x' + JSON.stringify(extra).length, ...base, ...extra } as never)
    expect(r.deny).toBeUndefined()
  }
  expect(w.rows('hand_back').length).toBe(0)
})

test('act on a Sonnet parent: nothing handed back', SLOW, async ($, on) => {
  const w = await world($, on, { settings: { agentStarts: 'act' }, model: SONNET })
  await w.open()
  expect((await w.agent({})).deny).toBeUndefined()
  expect(w.rows('agent_start')[0]).toMatchObject({ would: 'none', parent_model: SONNET })
})

test('an unseen agent type with no model: starts, would unknown; once it resolved to Haiku it does not inherit', SLOW, async ($, on) => {
  const w = await world($, on, { settings: { agentStarts: 'act' }, resolve: { 'my:scout': 'claude-haiku-5-5' } })
  await w.open()
  expect((await w.agent({ subagent_type: 'my:scout' })).deny).toBeUndefined()
  expect(w.rows('agent_start')[0]).toMatchObject({ would: 'unknown', inherits: null })
  expect((await w.agent({ subagent_type: 'my:scout', prompt: 'Search more' })).deny).toBeUndefined()
  expect(w.rows('agent_start')[1]).toMatchObject({ would: 'none', inherits: false })
})

test('a nested gathering start inside an Opus subagent is handed back the same way; agent_end counts tools', SLOW, async ($, on) => {
  const w = await world($, on, { settings: { agentStarts: 'act' } })
  await w.open()
  // A builder subagent on Opus makes a request, then starts a research agent
  await w.agent({ description: 'Implement the page', prompt: 'Build it.' })
  await w.t.step({ turnId: 'sub', agentId: 'ag1', model: OPUS }, api(60_000, 0, OPUS), ['Read', 'Edit', 'WebFetch'])
  const r = await $.agent.spawn({ tool_use_id: 'n1', prompt: 'Search docs', description: 'Docs lookup', subagentType: 'general-purpose', background: false, provider: 'firstParty', parentModel: OPUS, parentAgentId: 'ag1', fork: false } as never)
  expect(String(r.deny)).toContain('not started')
  await eventsIdle()
  expect(w.rows('hand_back')[0]).toMatchObject({ parent_tokens: 60_002 })
  // The subagent ends without starting it again: dropped, and its agent_end
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 'sub', agentId: 'ag1' })
  await eventsIdle()
  expect(w.rows('hand_back_answer')[0]).toMatchObject({ answer: 'dropped' })
  expect(w.rows('agent_end')[0]).toMatchObject({ agent_id: 'ag1', model: OPUS, requests: 1, cache_read: 60_000, tools_read: 1, tools_write: 1, tools_web: 1, tools_browser: 0 })
})

test('session starts, act: a large fork is handed back; repeated it passes; a hand-off the same', SLOW, async ($, on) => {
  const w = await world($, on, { settings: { sessionStarts: 'act' } })
  await w.open()
  const r = await w.session(START_SESSION, { context: 'fork', model: SONNET })
  expect(String(r.deny)).toContain('copies this conversation (200k tokens')
  expect(w.starts.length).toBe(0)
  expect(w.rows('side_start')[0]).toMatchObject({ tool: 'start_session', context: 'fork', action: 'hand_back', result: 'denied', would: 'hand_back' })
  expect(w.rows('hand_back')[0]).toMatchObject({ about: 'session_fork', suggested: 'fresh' })
  const again = await w.session(START_SESSION, { context: 'fork', model: SONNET })
  expect(again.deny).toBeUndefined()
  expect(w.rows('side_start')[1]).toMatchObject({ action: 'passed_after_hand_back', result: 'started', child: 'local_abc-1' })
  expect(w.rows('hand_back_answer')[0]).toMatchObject({ answer: 'fork_again', child: 'local_abc-1' })
  const h = await w.session(HAND_OFF, { remaining_plan: 'Finish the tests.', prompt: undefined, context: undefined })
  expect(String(h.deny)).toContain('Use start_session with context: "fresh"')
})

test('session starts, act: fresh with no model from Opus is handed back; naming one passes (cheaper)', SLOW, async ($, on) => {
  const w = await world($, on, { settings: { sessionStarts: 'act' } })
  await w.open()
  const r = await w.session(START_SESSION, {})
  expect(String(r.deny)).toContain('No model is named')
  const again = await w.session(START_SESSION, { model: SONNET })
  expect(again.deny).toBeUndefined()
  expect(w.rows('hand_back_answer')[0]).toMatchObject({ answer: 'cheaper', child: 'local_abc-1' })
  expect(w.rows('side_start')[1]).toMatchObject({ result: 'started', model_named: SONNET })
})

test('session starts, count: nothing handed back, side_start says what act would do', SLOW, async ($, on) => {
  const w = await world($, on)
  await w.open()
  expect((await w.session(START_SESSION, {})).deny).toBeUndefined()
  expect((await w.session(START_SESSION, { context: 'fork', prompt: 'Other brief' })).deny).toBeUndefined()
  expect(w.rows('side_start').map(r => r.would)).toEqual(['hand_back', 'hand_back'])
  expect(w.rows('side_start').map(r => r.action)).toEqual(['none', 'none'])
  expect(w.starts.length).toBe(2)
})

test('no dialog and no toast across every setting combination', SLOW, async ($, on) => {
  const w = await world($, on)
  await w.open()
  const toasts = w.t.env.toasts.length
  let i = 0
  for (const agentStarts of ['count', 'act']) for (const sessionStarts of ['count', 'act']) {
    w.t.store['settings'] = { billing: 'subscription', away: 'keep', coldAsk: 'off', atTarget: 'off', agentStarts, sessionStarts }
    // The Global scope is read at session start
    await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as never)
    await w.agent({ prompt: 'Search ' + ++i })
    await w.agent({ prompt: 'Search ' + ++i, model: 'opus' })
    await w.session(START_SESSION, { prompt: 'Brief ' + ++i })
    await w.session(START_SESSION, { prompt: 'Brief ' + ++i, context: 'fork' })
  }
  expect(w.asked.length).toBe(0)
  expect(w.t.env.toasts.length).toBe(toasts)
})

test('event log off: starts behave and no file is written', { timeoutMs: 60_000 }, async ($, on) => {
  const w = await world($, on, { settings: { agentStarts: 'act' } })
  await w.open()
  expect((await w.agent({})).deny).toBeTruthy()
  expect(w.files.size).toBe(0)
})
