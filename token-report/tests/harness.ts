// Shared test setup: the engine's answers for usage, store, steps, spawns; helpers to raise events and read drawings.
import { expect, mock } from 'claude-code/testing'

export const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
export const pane = (bodyColumns: number) => ({
  component: 'Pane', requestId: 'token-report',
  props: { title: 'Token Report', isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
}) as const

export const api = (cr: number, cw: number, model: string, input = 2, output = 300) =>
  ({ input_tokens: input, cache_read_input_tokens: cr, cache_creation_input_tokens: cw, output_tokens: output, model })

export function setup($: any, on: any, start = 1_000_000) {
  const clock = mock.clock(on, { now: start })
  const store: Record<string, unknown> = {}
  const env = { tokens: 180_000 as number | undefined, cost: 1, opened: [] as string[], toasts: [] as string[], limits: undefined as unknown[] | undefined }
  on('store.get', async (_$: unknown, e: { key: string }) => ({ value: store[e.key] }))
  on('store.set', async (_$: unknown, e: { key: string; value: unknown }) => { store[e.key] = JSON.parse(JSON.stringify(e.value)); return { value: undefined } })
  on('store.delete', async (_$: unknown, e: { key: string }) => { delete store[e.key]; return { value: undefined } })
  on('store.keys', async () => ({ value: Object.keys(store) }))
  on('session.id', async () => ({ value: 'live' }))
  on('session.usage', async () => ({
    value: {
      startedAt: start - 42 * 60_000,
      context: { tokens: env.tokens },
      rateLimits: env.limits ?? [{ kind: 'five_hour', percentUsed: 40, resetsAt: new Date(start + 3 * 3_600_000).toISOString() }, { kind: 'seven_day', percentUsed: 81, resetsAt: new Date(start + 50 * 3_600_000).toISOString() }],
      cost: { usd: env.cost },
    },
  }))
  on('ui.render', async ($: any, e: any) => $.ui.resolve(e).Box({}))
  on('session.start', async (_$: unknown, e: unknown) => ({ ...(e as object) }))
  on('turn.complete', async (_$: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('ui.toast', async (_$: unknown, e: { text: string }) => { env.toasts.push(e.text); return { value: undefined } })
  on('ui.open', async (_$: unknown, e: { id: string }) => { env.opened.push(e.id); return { value: { isPlaced: true } } })
  on('ui.close', async () => ({ value: undefined }))
  on('command.register', async () => ({ value: undefined }))
  let stepUsage: unknown = null
  let stepTools: string[] = []
  on('turn.step', async function* (_$: unknown, e: { turnId: string; index: number }) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: stepTools.map(name => ({ name, input: {} })), stopReason: 'end_turn', usage: stepUsage }
  })
  on('tool.call', async () => ({ result: 'done' }))
  let spawnId = 0
  on('agent.spawn', async () => ({ model: 'claude-haiku-5-5', agentId: 'ag' + ++spawnId }))

  const step = async (input: Record<string, unknown>, u: unknown, tools: string[] = []) => {
    stepUsage = u; stepTools = tools
    const st = await $.turn.step({ turnId: 't1', index: 0, messageCount: 3, model: 'claude-opus-5-5', ...input })
    for await (const _ of st) { /* drain */ }
    return st.result
  }
  const complete = (fields: Record<string, unknown>) =>
    $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', ...fields })
  const spawnAgent = async (toolUseId: string, description: string, type = 'Explore') => {
    await $.tool.call({ tool: 'Agent', tool_use_id: toolUseId, description, prompt: 'p', subagent_type: type, model: 'haiku' })
    await $.agent.spawn({ tool_use_id: toolUseId, prompt: 'p', description, subagentType: type, background: false, provider: 'firstParty', parentModel: 'claude-opus-5-5', fork: false })
  }
  // All text of a drawing (Texts and Button labels), checked for NaN/undefined
  const drawn = async (ui: any) => {
    const texts = (await ui.findAll({ type: 'Text' })).map((n: { text: string }) => n.text)
    const labels = (await ui.findAll({ type: 'Button' })).map((n: { props: { label?: string } }) => '[' + (n.props.label || '') + ']')
    const all = [...texts, ...labels].join('')
    expect(all).not.toMatch(/NaN|undefined/)
    return all
  }
  return { clock, store, env, step, complete, spawnAgent, drawn }
}
