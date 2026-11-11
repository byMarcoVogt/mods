// The Agents page (v2 slice 3, plan/v2-slice3-agents.md § 3): which agents and sessions this session set
// going, on which model, what they cost, and where a cheaper choice existed. Three exhibits: actual
// against Managed's plan for the whole tree, the layers of sessions below this one, and this session's
// own agents by kind. Never a "saving": the plan is named and its assumption printed beside it.
import type { RenderElement } from 'claude-code'

import { agentPlan, agentTable, shortModel, standOuts, wouldManagedChange, type Node } from '../agents'
import { C, money, num, type PageCtx } from '../kit'
import type { Agent } from '../ledger'

const NARROW = 100
const xml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const cut = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + '…' : t)

export function drawAgents(ctx: PageCtx): RenderElement {
  const { Box, Text, Button, Svg } = ctx.ui
  const d = ctx.data
  const s = ctx.settings
  const tree = d.tree
  const agents: Agent[] = Object.values(d.L.agents)
  const isNarrow = ctx.columns < NARROW
  const atApi = d.billing.billing === 'api' ? '' : ' at API prices'
  const $$ = (usd: number) => money(usd, s)

  // ---- head: the policy in force, and the one action -------------------------------------------------
  const pv = d.profile
  const name = pv.profile === 'managed' ? 'Managed' : 'Auto'
  const head = 'Profile: ' + name + (pv.from === 'project' || pv.from === 'session' ? ' (' + pv.from + ')' : '') +
    (pv.changed.length ? ', ' + pv.changed.length + ' changed' : '') + ' · Agent starts: ' + s.agentStarts + ' · Session starts: ' + s.sessionStarts
  const isOffer = pv.profile !== 'managed' && d.hasProject && wouldManagedChange(agents, tree)
  const headRow = (
    <Box key="ag-head" flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
      <Text dimColor>{head}</Text>
      {isOffer ? <Button key="ag-managed" label={'Use Managed in ' + d.folder} onPress={() => ctx.act.setProfile('managed', 'project')} /> : null}
    </Box>
  )

  if (tree.own.n === 0 && tree.children.length === 0) {
    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        {headRow}
        <Text key="ag-empty">No agents or side sessions below this session yet.</Text>
      </Box>
    )
  }

  // ---- 1. actual against plan, the whole tree ---------------------------------------------------------
  const diff = tree.usd - tree.plan
  const isSame = diff < 0.005
  const counts = tree.own.n + (tree.own.n === 1 ? ' agent' : ' agents') +
    (tree.sessions ? ' · ' + tree.sessions + (tree.sessions === 1 ? ' session' : ' sessions') + ' in ' + tree.layers + (tree.layers === 1 ? ' layer' : ' layers') : '') +
    (tree.notReported ? ' · ' + tree.notReported + ' not reported' : '')
  const top = 'Below this session: ' + $$(tree.usd) + atApi + ' · ' + counts
  const assumption = 'Plan: Managed\'s rule. Research agents that inherited Opus or Fable, and new sessions started with no model, run on Sonnet with the same requests and tokens (in this account\'s matched jobs Sonnet used no more). Forks start fresh. List prices: a valuation, not money paid.'
  const W = 320, BAR = 220
  const scale = Math.max(tree.usd, tree.plan, 1e-9)
  const wA = Math.max(2, Math.round((tree.usd / scale) * BAR)), wP = Math.max(2, Math.round((tree.plan / scale) * BAR))
  const bars = isSame
    ? "<svg xmlns='http://www.w3.org/2000/svg' width='" + W + "' height='22' viewBox='0 0 " + W + " 22'><rect x='0' y='4' width='" + wA + "' height='14' rx='3' fill='#61afef'/>" +
      "<text x='" + (wA + 6) + "' y='16' font-size='12' font-family='sans-serif' fill='#8a8a8a'>actual " + xml($$(tree.usd)) + '</text></svg>'
    : "<svg xmlns='http://www.w3.org/2000/svg' width='" + W + "' height='44' viewBox='0 0 " + W + " 44'>" +
      "<rect x='0' y='4' width='" + wA + "' height='14' rx='3' fill='#61afef' fill-opacity='0.35'/><rect x='0' y='4' width='" + wP + "' height='14' rx='3' fill='#61afef'/>" +
      "<text x='" + (wA + 6) + "' y='16' font-size='12' font-family='sans-serif' fill='#8a8a8a'>actual " + xml($$(tree.usd)) + '</text>' +
      "<rect x='0' y='26' width='" + wP + "' height='14' rx='3' fill='" + C.ok + "'/>" +
      "<text x='" + (wP + 6) + "' y='38' font-size='12' font-family='sans-serif' fill='#8a8a8a'>plan " + xml($$(tree.plan)) + '</text></svg>'
  const blocks = (usd: number) => '█'.repeat(Math.max(1, Math.round((usd / scale) * 20)))
  const ex1 = (
    <Box key="ag-ex1" flexDirection="column">
      <Text key="ag-top">{top}</Text>
      {Svg ? <Svg key="ag-bars" source={bars} alt={'actual ' + $$(tree.usd) + ', plan ' + $$(tree.plan)} width={W} height={isSame ? 22 : 44} /> : (
        <Box key="ag-blocks" flexDirection="column">
          <Text>{'actual ' + blocks(tree.usd) + ' ' + $$(tree.usd)}</Text>
          {isSame ? null : <Text color={C.ok}>{'plan   ' + blocks(tree.plan) + ' ' + $$(tree.plan)}</Text>}
        </Box>
      )}
      <Text key="ag-diff">{isSame ? 'Nothing here that Managed would have changed.' : 'Difference to plan ' + $$(diff) + '.'}</Text>
      <Text key="ag-assume" dimColor>{assumption}</Text>
    </Box>
  )

  // ---- 2. the layers ----------------------------------------------------------------------------------
  const ownLine = 'This session · agents ' + tree.own.n + ' · ' + $$(tree.own.usd) + (tree.own.plan < tree.own.usd - 0.005 ? '   plan ' + $$(tree.own.plan) : '')
  const lines: RenderElement[] = [<Text key="ag-l-own">{ownLine}</Text>]
  const nodeLine = (n: Node, isLast: boolean, indent: string) => {
    const branch = indent + (isLast ? '└ ' : '├ ')
    const title = cut(n.title, 32)
    let text: string
    if (!n.reported) text = branch + title + (n.model ? ' · ' + shortModel(n.model) : '') + ' · not reported'
    else {
      const ag = isNarrow ? ' · ' + n.agents.n + (n.agents.n === 1 ? ' agent' : ' agents') : ' · agents ' + n.agents.n + (n.agents.n ? ' · ' + $$(n.agents.usd) : '')
      text = branch + title + ' · ' + shortModel(n.model) + ' · ' + $$(n.usd) + ag +
        (n.subPlan < n.subUsd - 0.005 ? '   plan ' + $$(n.subPlan) : '') + (n.reason ? '   ' + n.reason : '')
    }
    lines.push(<Text key={'ag-l-' + n.id} {...(n.reported ? {} : { dimColor: true })}>{text}</Text>)
    const below = indent + (isLast ? '  ' : '│ ')
    n.children.forEach((c, i) => nodeLine(c, i === n.children.length - 1 && !n.deeper.n, below))
    if (n.deeper.n) lines.push(<Text key={'ag-l-deep-' + n.id} dimColor>{below + '└ + ' + n.deeper.n + ' deeper · ' + $$(n.deeper.usd)}</Text>)
  }
  tree.children.forEach((c, i) => nodeLine(c, i === tree.children.length - 1, ''))
  const ex2 = tree.children.length ? (
    <Box key="ag-ex2" flexDirection="column">
      <Text key="ag-ex2-h" bold>Layers</Text>
      {lines}
      {tree.notReported ? <Text key="ag-ex2-n" dimColor>Not reported: a session that never loaded this version of Token Report, one older than 3 days, one on another machine or in the cloud, or one still on its first turn.</Text> : null}
    </Box>
  ) : null

  // ---- 3. this session's agents by kind and model, and what to do instead --------------------------------
  const table = agentTable(agents, s.agentStarts)
  const KIND_W = 26, CELL_W = 18
  const cellText = (c: { n: number; usd: number } | undefined) => (c ? $$(c.usd) + ' · ' + c.n : '–')
  const tableRows: RenderElement[] = []
  if (table.rows.length) {
    if (!isNarrow) {
      tableRows.push(
        <Box key="ag-t-h" flexDirection="row">
          <Box width={KIND_W}><Text dimColor>This session's agents</Text></Box>
          {table.models.map(m => <Box key={'ag-t-h-' + m} width={CELL_W}><Text dimColor>{m}</Text></Box>)}
          <Text dimColor>Instead</Text>
        </Box>,
      )
    } else tableRows.push(<Text key="ag-t-h" dimColor>This session's agents</Text>)
    for (const r of table.rows) {
      if (isNarrow) {
        const cells = table.models.filter(m => r.cells[m]).map(m => cellText(r.cells[m]) + ' · ' + m).join(', ')
        tableRows.push(<Text key={'ag-t-' + r.kind}>{r.label + ': ' + cells + (r.instead ? ' → ' + r.instead : '')}</Text>)
      } else {
        tableRows.push(
          <Box key={'ag-t-' + r.kind} flexDirection="row">
            <Box width={KIND_W}><Text>{r.label}</Text></Box>
            {table.models.map(m => <Box key={'ag-t-' + r.kind + '-' + m} width={CELL_W}><Text>{cellText(r.cells[m])}</Text></Box>)}
            <Text {...(r.instead ? {} : { dimColor: true })}>{r.instead || '–'}</Text>
          </Box>,
        )
      }
    }
  }
  const outs = standOuts(agents)
  const outLine = (a: Agent) => {
    const plan = agentPlan(a)
    return shortModel(a.model) + ' · ' + cut(a.description || a.type, 48) + ' · ' + $$(a.usd) +
      (plan < a.usd - 0.005 ? ' · plan ' + $$(plan) : '') + (num(a.endedAt) ? '' : ' · running') +
      (a.named ? ' · named' : a.inherits ? ' · inherited' : '')
  }
  const ex3 = table.rows.length ? (
    <Box key="ag-ex3" flexDirection="column">
      {tableRows}
      {outs.map(a => <Text key={'ag-o-' + a.id} color={C.warn}>{'↳ ' + outLine(a)}</Text>)}
    </Box>
  ) : null

  return (
    <Box flexDirection="column" gap={1} paddingX={1}>
      {headRow}
      {ex1}
      {ex2}
      {ex3}
    </Box>
  )
}
