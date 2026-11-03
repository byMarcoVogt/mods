// The pane's frame: the title over four drawn cards (chat, cache, session, plan), then the Settings
// page in its own rounded box.
import type { RenderElement } from 'claude-code'

import { C, k, mins, money, type PageCtx } from './kit'
import { sessionUsd } from './ledger'
import { ctxTokens } from './line'
import { drawSettings } from './pages/settings'

export function drawShell(ctx: PageCtx): RenderElement {
  const { Box, Text, Svg } = ctx.ui
  const d = ctx.data
  const total = sessionUsd(d.L, d.usage?.cost?.usd)
  const tokens = ctxTokens(d.usage)

  // The four values: [label, value, colour]; Cache turns red once cold
  const values: [string, string, string][] = [
    ['Chat', k(tokens), '#61afef'],
    ['Cache', d.cacheLeft === null ? '–' : d.cacheLeft <= 0 ? 'cold' : mins(d.cacheLeft), d.cacheLeft !== null && d.cacheLeft <= 0 ? '#e06c75' : '#98c379'],
    ['Session', money(total, ctx.settings), '#e5c07b'],
    ['Plan', d.billing.billing === 'api' ? 'API key' : d.billing.billing === 'subscription' ? 'subscription' : '?', '#c678dd'],
  ]
  // A drawn card with a 12 px radius: a see-through fill and coloured text read on both themes
  const card = (label: string, value: string, color: string) => {
    const w = Math.max(96, 18 + value.length * 9)
    const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='" + w + "' height='46' viewBox='0 0 " + w + " 46'><rect x='1' y='1' width='" + (w - 2) + "' height='44' rx='12' fill='" + color + "' fill-opacity='0.12' stroke='" + color + "' stroke-width='1.5'/>" +
      "<text x='12' y='18' font-size='11' font-family='sans-serif' fill='#8a8a8a'>" + label + "</text><text x='12' y='36' font-size='15' font-weight='600' font-family='sans-serif' fill='" + color + "'>" + value.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</text></svg>'
    return Svg ? <Svg key={'card-' + label} source={svg} alt={label + ': ' + value} width={w} height={46} /> : <Text key={'card-' + label}>{label} {value}</Text>
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column" gap={1}>
        <Text key="shell-title" bold>Token Report Settings</Text>
        <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">{values.map(([l, v, c]) => card(l, v, c))}</Box>
      </Box>
      <Box flexDirection="column" borderStyle="round" borderColor={C.frame} paddingX={1}>{drawSettings(ctx)}</Box>
    </Box>
  )
}
