// The Settings page: where a change applies, then Plan, Money, Cache management, Context management.
// Each row: the label, one dropdown, an ⓘ where a note helps, and a fact where one helps (detected plan,
// € rate, a price, this chat's size). No grey text under the rows. The ⓘ is a tooltip on hover: on a
// group header it says why, with this chat's numbers; on a row it says how, one line per choice.
import type { RenderElement } from 'claude-code'

import type { Settings } from '../../types'
import { k, money, num, type PageCtx } from '../kit'
import { priceFor } from '../ledger'
import { ctxTokens } from '../line'

type Choice = { value: string; label: string }
// The ⓘ: one line per choice, and a note under them
type Info = { lines?: [string, string][]; note?: string }
type Row = {
  id: string
  label: string
  // A choice (string setting), or a number with presets and "Custom…" (a field to type any value)
  choice?: { key: keyof Settings; choices: Choice[] }
  number?: { key: keyof Settings; presets: Choice[]; placeholder: string }
  // Free text: "No added instructions" or "Added instructions", which opens a field
  text?: { key: keyof Settings; placeholder: string }
  // The value the dropdown shows when the stored one is not among its choices
  cur?: string
  // A fact right of the dropdown
  fact?: string
  info?: Info
  // The band's Compact button before the label, same look and same action
  hasCompactButton?: boolean
  isHidden?: boolean
}
// A group's ⓘ is an insight: why the group matters
type Group = { id: string; title: string; rows: Row[]; info?: Info }

const LABEL_W = 20
const CUSTOM = 'custom'
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

// "650000", "650k", "0.65m" → a number, or null
const parse = (v: string): number | null => {
  const raw = v.trim().toLowerCase().replace(',', '.').replace(/\s/g, '')
  if (!raw) return null
  const n = raw.endsWith('m') ? parseFloat(raw) * 1_000_000 : raw.endsWith('k') ? parseFloat(raw) * 1000 : parseFloat(raw)
  return Number.isFinite(n) && n >= 0 ? n : null
}
const day = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? Number(m[3]) + ' ' + (MONTHS[Number(m[2]) - 1] ?? '') : iso
}
const xml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function drawSettings(ctx: PageCtx): RenderElement {
  const { Box, Text, Button, Select, Input, Svg } = ctx.ui
  const s = ctx.settings
  const d = ctx.data
  const opt = (value: string | number, label: string): Choice => ({ value: String(value), label })

  const billingName = (b: string) => (b === 'subscription' ? 'subscription' : b === 'api' ? 'API key' : 'nothing yet')
  // One rule for amounts: an estimate reads "≈ 0.07 €"; on a subscription the first amount of a tooltip
  // or fact ends with " at API prices", once
  const atApi = d.billing.billing === 'api' ? '' : ' at API prices'
  const fx = d.fx
  // "$1 = 0.90 € (ECB, 2 November)": the ECB publishes once a working day, around 16:00 CET
  const fxLine = s.currency === 'eur' && fx && num(fx.rate) ? '$1 = ' + fx.rate.toFixed(2) + ' € (' + (fx.isLive ? 'ECB' + (fx.asOf ? ', ' + day(fx.asOf) : '') : 'fallback rate') + ')' : ''
  // Cache management: one row for while you're away. On a 5 min cache the Cache Warmer runs for minutes
  // (a ping every ~4 min outweighs one rewrite after ~45 min) and "Compact" is left out (it would compact
  // after every short pause).
  const isShort = d.ttlMin < 60
  // Two by two: Cache Warmer or not, then compact or keep the full chat
  const awayChoices = [
    ...(isShort ? [] : [opt('compact', 'Compact')]), opt('keep', 'Keep full'),
    opt('warm-compact', 'Cache Warmer, then compact'), opt('warm-keep', 'Cache Warmer, then keep full'),
  ]
  // Who compacts: Token Report under Claude Code's idle threshold, Claude Code from it on
  const idle = num(d.idleThreshold) ? k(d.idleThreshold) : ''
  const whoCompacts = idle ? 'under ' + idle + ' by Token Report, from ' + idle + ' by Claude Code\'s own idle compaction' : 'by Token Report (Claude Code\'s idle compaction is off)'
  const warmChoices = isShort ? [opt('15m', '15 min'), opt('30m', '30 min'), opt('45m', '45 min')] : [opt('1h', '1 h'), opt('2h', '2 h'), opt('5h', '5 h')]
  const warmCur = warmChoices.some(c => c.value === s.keepWarm) ? s.keepWarm : warmChoices[isShort ? 2 : 0]!.value
  const isWarmAway = s.away === 'warm-compact' || s.away === 'warm-keep'
  // What an hour of warming costs at today's size: one ping shortly before each expiry
  const pingsPerHour = 60 / Math.max(1, d.ttlMin - (d.ttlMin >= 60 ? 4 : 1.25))
  const perHour = num(d.pingUsd) ? '≈ ' + money(d.pingUsd * pingsPerHour, s, '') + ' per hour' + atApi : ''
  // This chat's numbers for the insights: its size, a message on a warm cache (one read of the chat),
  // the same on a cold one (the whole chat written again)
  const ctxNow = ctxTokens(d.usage)
  const chat = num(ctxNow) ? k(ctxNow) : ''
  const warm = num(d.pingUsd) ? money(d.pingUsd, s) : ''
  const cold = num(d.rewriteUsd) ? money(d.rewriteUsd, s) : ''
  // What a million tokens cost on this chat's model: read from the cache, new input, written to it
  const model = d.L.main.model
  const p = priceFor(model, ctxNow ?? 0)
  const perM = (usd: number) => money(usd, s, '')
  // An amount in your currency, as the cold-send row names it: "0.50 €", "$0.50"
  const amount = (v: number) => (s.currency === 'usd' ? '$' + v.toFixed(2) : v.toFixed(2) + ' €')
  // "claude-opus-5-5" → "Opus 5.5"
  const modelName = model ? model.replace('claude-', '').replace(/^(\w)(\w*)-(.*)$/, (_m: string, a: string, b: string, v: string) => a.toUpperCase() + b + ' ' + v.replace(/-/g, '.')) : ''
  const prices = model ? 'API prices per million tokens on ' + modelName + ': read from the cache ' + perM(p.cacheRead) +
    ' | new input ' + perM(p.input) + ' | written to the cache ' + perM(d.ttlMin >= 60 ? p.write1h : p.write5m) + '.' : ''
  // The next 10 messages, rereading the chat at today's size, against the size this session's last
  // compaction left (measured, never guessed), plus that one compaction (a read of the chat and the
  // summary written)
  const tenNow = num(d.pingUsd) ? d.pingUsd * 10 : null
  const tenAfter = num(d.lastSummary) ? (d.lastSummary * p.cacheRead) / 1e6 * 10 : null
  const once = num(d.pingUsd) && num(d.lastSummary) ? d.pingUsd + (d.lastSummary * p.output) / 1e6 : null
  const tenLine = num(tenNow) && num(ctxNow) && ctxNow >= 50_000
    ? '\nThe next 10 messages reread the chat for ' + money(tenNow, s) + (num(tenAfter) && num(once) && num(d.lastSummary) && d.lastSummary < ctxNow
      ? '. After compacting to about ' + k(d.lastSummary) + ' (your last summary) it is ' + money(tenAfter, s) + ', plus ' + money(once, s) + ' once for the summary.'
      : '. After your first compaction this shows what a summary saves.')
    : ''
  // Context management: the threshold. Presets at or past the window are left out (never reached)
  const win = num(d.window) ? d.window : null
  const presets = [200_000, 300_000, 400_000, 600_000].filter(v => !win || v < win).map(v => opt(v, k(v)))

  const GROUPS: Group[] = [
    {
      id: 'plan',
      title: 'Plan',
      rows: [
        {
          id: 'billing', label: 'Type',
          choice: { key: 'billing', choices: [opt('auto', 'Detect automatically'), opt('subscription', 'Subscription (Pro / Max)'), opt('api', 'API key')] },
          fact: s.billing === 'auto' ? 'Detected: ' + billingName(d.billing.billing) : undefined,
          info: {
            lines: [
              ['Subscription', 'Pro or Max: you pay a monthly price, and a message uses part of your plan\'s limits, not money. Prices here show what the same tokens would cost with an API key.'],
              ['API key', 'You pay for every token. Prices here are what you are billed.'],
            ],
          },
        },
      ],
    },
    {
      id: 'money',
      title: 'Money',
      rows: [
        {
          id: 'currency', label: 'Currency',
          choice: { key: 'currency', choices: [opt('usd', '$'), opt('eur', '€')] },
          fact: fxLine || undefined,
        },
      ],
    },
    {
      id: 'cache',
      title: 'Cache management',
      info: {
        note: 'After each message Claude keeps your chat ready, in the "cache", for ' + d.ttlMin + ' min. A message while it is ready costs about a tenth. After that, the whole chat loads again at full price.' +
          (prices ? '\n' + prices : '') +
          (chat && warm && cold ? '\nYour chat: ' + chat + '. The next message costs ' + warm + ' while it is ready, ' + cold + ' once it went cold' + atApi + '.' : ''),
      },
      rows: [
        {
          id: 'away', label: "When you're away",
          choice: { key: 'away', choices: awayChoices },
          info: {
            lines: [
              ...(isShort ? [] : [['Compact', 'Before the cache runs out, the chat is summarised, ' + whoCompacts + '. Your next message is small and cheap.'] as [string, string]]),
              ['Keep full', 'Nothing is summarised. Your next message reloads ' + (chat ? 'all ' + chat + (cold ? ' for ' + cold + atApi : '') : 'the whole chat') + '.'],
              ['Cache Warmer, then compact', 'A tiny ping keeps the full chat ready for the time you pick. Then it is summarised the same way.'],
              ['Cache Warmer, then keep full', 'The same, then the full chat runs out as it is.'],
            ],
          },
        },
        {
          id: 'keepWarm', label: 'Cache Warmer for', isHidden: !isWarmAway,
          choice: { key: 'keepWarm', choices: warmChoices },
          cur: warmCur,
          fact: perHour ? perHour + ', from your last message' : undefined,
        },
        {
          id: 'coldAsk', label: 'Ask before a cold send',
          choice: { key: 'coldAsk', choices: [opt('off', 'Never'), ...['0.25', '0.5', '1'].map(v => opt(v, 'Above ' + amount(Number(v)))), opt('any', 'Always')] },
          info: { note: 'When the cache has gone cold, a window asks before your message goes: Send anyway | Compact, then send | Cancel. A small chat costs little cold, so it only asks above the amount you pick' + atApi + '.' },
        },
      ],
    },
    {
      id: 'context',
      title: 'Context management',
      info: {
        note: 'Every message carries the whole chat. The bigger the chat, the more each message costs, and very long chats often answer less reliably.\nCompacting replaces the chat with a short summary and carries on. It costs about one message, and every message after it is cheaper.' +
          (chat && warm ? '\nYour chat: ' + chat + '. Rereading it costs ' + warm + ' per message' + atApi + ', before your words and the answer.' : '') +
          tenLine,
      },
      rows: [
        {
          id: 'contextTarget', label: 'Threshold',
          // Max is Claude Code's own auto-compact point, named with its size
          number: { key: 'contextTarget', placeholder: 'e.g. 500k', presets: [...presets, opt(0, num(d.compactAt) ? 'Max (' + k(d.compactAt) + ')' : 'Max')] },
          fact: chat ? 'Your chat: ' + chat : undefined,
        },
        {
          id: 'atTarget', label: 'At the threshold',
          choice: { key: 'atTarget', choices: [opt('off', 'Off'), opt('remind', 'Reminder'), opt('ask', 'Ask'), opt('compact', 'Compact')] },
          info: {
            lines: [
              ['Off', 'The band turns orange, then red.'],
              ['Reminder', 'A pop-up at the threshold and every further 100k. ⤓ in the band compacts.'],
              ['Ask', 'A window with three buttons: Compact | Not now | Stop asking (this session).'],
              ['Compact', 'Summarises right after the turn that crosses it, while it is cheap.'],
            ],
          },
        },
        {
          id: 'unattended', label: 'Turns nobody typed',
          choice: { key: 'unattended', choices: [opt('count', 'Count only'), opt('act', 'Act')] },
          info: {
            lines: [
              ['Count only', 'A message from another session, a notification or a schedule runs as it comes. Never a window: Ask becomes a pop-up.'],
              ['Act', 'Compacts after such a turn above the threshold, and before one that would reload a cold chat above the amount in Ask before a cold send. Meant for a project where you orchestrate.'],
            ],
          },
        },
        {
          id: 'compactNote', label: '/compact', hasCompactButton: true,
          text: { key: 'compactNote', placeholder: 'e.g. keep the plan, open tasks and file paths' },
          info: { note: 'Text added to the /compact prompt, e.g. "keep the plan, open tasks and file paths". Used for every summary Token Report starts, and for Claude Code\'s own summary while you\'re away.' + (s.compactNote ? '\nYours: "' + s.compactNote + '"' : '') },
        },
      ],
    },
    {
      id: 'starts',
      title: 'Agents and side sessions',
      rows: [
        {
          id: 'agentStarts', label: 'Agent starts',
          choice: { key: 'agentStarts', choices: [opt('count', 'Count only'), opt('act', 'Hand back')] },
          info: {
            lines: [
              ['Count only', 'Agents start as asked and are counted.'],
              ['Hand back', 'A research agent that would inherit Opus or Fable is sent back once to name a model. One that names an expensive model starts, with one note per session. A call that names a model always starts.'],
            ],
          },
        },
        {
          id: 'sessionStarts', label: 'Session starts',
          choice: { key: 'sessionStarts', choices: [opt('count', 'Count only'), opt('act', 'Hand back')] },
          info: {
            lines: [
              ['Count only', 'New sessions start as asked and are counted.'],
              ['Hand back', 'A new session with no model named from an Opus or Fable chat, or a fork of a large chat, is sent back once to name a model or start fresh. A call that names a model always passes.'],
            ],
          },
        },
      ],
    },
  ]

  // ---- pieces ------------------------------------------------------------------------------
  // The ⓘ: a tooltip on hover, an Svg whose <title> the browser shows. The whole square answers the
  // pointer (a see-through rect: an empty circle only reacted on its thin ring), with the help cursor;
  // the "i" is drawn, not text, so no text cursor appears over it. Without Svg (terminal): nothing.
  const infoText = (info: Info) => [...(info.lines ?? []).map(([a, b]) => a + ': ' + b), info.note ?? ''].filter(Boolean).join('\n')
  const infoMark = (id: string, label: string, info: Info | undefined): RenderElement | null => {
    if (!info || !Svg) return null
    const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16' style='cursor:help'><title>" + xml(infoText(info)) +
      "</title><rect width='16' height='16' fill='#000' fill-opacity='0'/><circle cx='8' cy='8' r='6.5' fill='none' stroke='#8a8a8a' stroke-width='1.2' pointer-events='none'/>" +
      "<circle cx='8' cy='5' r='0.9' fill='#8a8a8a' pointer-events='none'/><rect x='7.3' y='6.8' width='1.4' height='4.6' rx='0.5' fill='#8a8a8a' pointer-events='none'/></svg>"
    return <Svg key={'set-i-' + id} source={svg} alt={'About ' + label} width={16} height={16} isInteractive />
  }

  // One dropdown (a row of buttons where the surface has no Select)
  const control = (id: string, choices: Choice[], cur: string, set: (v: string) => unknown): RenderElement =>
    Select ? (
      <Select key={'set-sel-' + id} options={choices.slice(0, 64)} value={cur} onSelect={v => void set(v)} />
    ) : (
      <Box key={'set-c-' + id} flexDirection="row" flexWrap="wrap">
        {choices.map(c => (
          <Button key={'set-' + id + '-' + c.value} {...(c.value === cur ? {} : { plain: true as const })} label={c.label} onPress={() => set(c.value)} />
        ))}
      </Box>
    )

  // A field under the dropdown, opened by "Custom…" or "Added instructions"
  const fieldOf = (r: Row, placeholder: string, value: string, onSubmit: (v: string) => void): RenderElement | null =>
    Input ? <Input {...{ key: 'set-in-' + r.id, placeholder, value, submitLabel: 'set', onSubmit }} /> : null

  const rowOf = (r: Row): RenderElement => {
    let ctl: RenderElement | null = null
    let field: RenderElement | null = null
    const customKey = 'settings.custom.' + r.id
    const isCustomOpen = ctx.get(customKey, '') === 'open'
    if (r.choice) {
      const ch = r.choice
      ctl = control(r.id, ch.choices, r.cur ?? String(s[ch.key]), v => ctx.act.setSetting(ch.key, v as never))
    } else if (r.number) {
      const nr = r.number
      const value = Number(s[nr.key]) || 0
      const isPreset = nr.presets.some(p => Number(p.value) === value)
      // "Custom…" opens the field; a custom value already set shows as its own entry
      const cur = isPreset && !isCustomOpen ? String(value) : CUSTOM
      ctl = control(r.id, [...nr.presets, opt(CUSTOM, isPreset ? 'Custom…' : 'Custom: ' + k(value))], cur, v => {
        if (v === CUSTOM) return ctx.set(customKey, 'open')
        ctx.set(customKey, '')
        return ctx.act.setSetting(nr.key, Number(v) as never)
      })
      if (isCustomOpen) {
        field = fieldOf(r, nr.placeholder, '', v => {
          const n = parse(v)
          if (n === null) return
          ctx.set(customKey, '')
          // A threshold under 50k would compact a chat whose summary is about as big: 50k at least
          void ctx.act.setSetting(nr.key, Math.max(50_000, Math.round(n)) as never)
        })
      }
    } else if (r.text) {
      const tr = r.text
      const text = String(s[tr.key] ?? '')
      ctl = control(r.id, [opt('', 'No added instructions'), opt(CUSTOM, 'Added instructions')], text || isCustomOpen ? CUSTOM : '', v => {
        if (v === CUSTOM) return ctx.set(customKey, 'open')
        ctx.set(customKey, '')
        return ctx.act.setSetting(tr.key, '' as never)
      })
      if (isCustomOpen) {
        field = fieldOf(r, tr.placeholder, text, v => {
          ctx.set(customKey, '')
          void ctx.act.setSetting(tr.key, v.trim() as never)
        })
      }
    }
    const key = String(r.choice?.key ?? r.number?.key ?? r.text?.key ?? '')
    // Where this row's value comes from, when not from Global
    const from = d.sessionKeys.includes(key) ? 'session' : d.projectKeys.includes(key) ? 'project' : ''
    return (
      <Box key={'set-row-' + r.id} flexDirection="column">
        <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
          <Box key={'set-l-' + r.id} width={LABEL_W} flexDirection="row" gap={1} alignItems="center">
            {r.hasCompactButton ? <Button key={'set-cb-' + r.id} label="⤓" variant="primary" onPress={() => ctx.act.compact()} /> : null}
            <Text>{r.label}</Text>
          </Box>
          {ctl}
          {infoMark(r.id, r.label, r.info)}
          {r.fact ? <Text dimColor>{r.fact}</Text> : null}
          {from ? <Text dimColor>{'(' + from + ')'}</Text> : null}
        </Box>
        {field ? <Box paddingLeft={LABEL_W + 1} width={LABEL_W + 40}>{field}</Box> : null}
      </Box>
    )
  }

  // Where a change goes: Global, this project's file, or this session alone
  const scopeLine = (
    <Box key="set-scope" flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
      <Box width={LABEL_W}><Text>Changes apply to</Text></Box>
      {control('scope', [opt('global', 'Global'), opt('project', 'Project (' + d.folder + ')'), opt('session', 'Session')], ctx.get('settings.scope', 'global'), v => ctx.set('settings.scope', v))}
      {infoMark('scope', 'Changes apply to', {
        lines: [
          ['Global', 'Every session on this computer.'],
          ['Project', 'Sessions in ' + d.folder + ' and its subfolders.'],
          ['Session', 'This chat only. Session beats Project, Project beats Global.'],
        ],
      })}
    </Box>
  )

  // Bold headers (each with its insight ⓘ) and space between the groups
  const groupOf = (g: Group): RenderElement => (
    <Box key={'set-g-' + g.id} flexDirection="column">
      <Box key={'set-h-' + g.id} flexDirection="row" gap={1} alignItems="center">
        <Text bold>{g.title}</Text>
        {infoMark('group-' + g.id, g.title, g.info)}
      </Box>
      {g.rows.filter(r => !r.isHidden).map(rowOf)}
    </Box>
  )
  return (
    <Box flexDirection="column" gap={1} paddingX={1}>
      {scopeLine}
      {GROUPS.map(groupOf)}
    </Box>
  )
}
