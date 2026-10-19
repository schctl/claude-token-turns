import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, SessionUsage } from 'claude-code'

import type { Base, Live, Meters, Spend, Turn } from '../types'

const KEEP = 50

const meters = atom({ plugin: 'token-turns', key: 'meters' } as const, null)
const turns = atom({ plugin: 'token-turns', key: 'turns' } as const, [])
const live = atom({ plugin: 'token-turns', key: 'live' } as const, null)
const isHidden = atom({ plugin: 'token-turns', key: 'isHidden' } as const, false)
const view = atom({ plugin: 'token-turns', key: 'view' } as const, 'compact')

const toMeters = (usage: Pick<SessionUsage, 'context' | 'rateLimits'>): Meters => {
  const limit = (kind: string) => {
    const found = usage.rateLimits.find(one => one.kind === kind)
    return found && { percent: found.percentUsed, resetsAt: found.resetsAt }
  }

  return {
    ctxTokens: usage.context.tokens,
    ctxWindow: usage.context.window,
    ctxPercent: usage.context.percent,
    five: limit('five_hour'),
    week: limit('seven_day'),
  }
}

const toBase = (m: Meters | null): Base | null =>
  m && { ctxTokens: m.ctxTokens, five: m.five?.percent, week: m.week?.percent }

const minus = (after?: number, before?: number) =>
  after === undefined || before === undefined ? undefined : Math.round((after - before) * 10) / 10

const withDeltas = (turn: Turn, m: Meters | null): Turn =>
  turn.base === null || m === null
    ? turn
    : {
        ...turn,
        ctxDelta: minus(m.ctxTokens, turn.base.ctxTokens),
        fiveDelta: minus(m.five?.percent, turn.base.five),
        weekDelta: minus(m.week?.percent, turn.base.week),
      }

const toSpend = (u: ModelUsage): Spend => ({
  fresh: u.input_tokens + u.cache_creation_input_tokens,
  cacheRead: u.cache_read_input_tokens,
  out: u.output_tokens,
})

const add = <S extends Spend>(a: S, b: Spend): S => ({
  ...a,
  fresh: a.fresh + b.fresh,
  cacheRead: a.cacheRead + b.cacheRead,
  out: a.out + b.out,
})

const delta = (s: Spend) => s.fresh + s.out

const measure = async ($: EngineInterface) => {
  try {
    const m = toMeters(await $.session.usage())
    await update($, meters, () => m)
    return m
  } catch {
    return read($, meters)
  }
}

// 950, 18.4k, 2.1M
export const fmt = (n: number) => {
  const abs = Math.abs(n)
  if (abs < 1000) return String(Math.round(n))
  if (abs < 1e6) return `${(n / 1e3).toFixed(abs < 1e5 ? 1 : 0).replace(/\.0$/, '')}k`
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`
}

const signed = (n: number, f: (n: number) => string = fmt) => (n < 0 ? `−${f(-n)}` : `+${f(n)}`)

const pct = (n: number) => `${n.toFixed(1).replace(/\.0$/, '')}%`

const heat = (percent?: number) =>
  percent === undefined ? 'subtle' : percent < 60 ? 'success' : percent < 85 ? 'warning' : 'error'

type Seg = { text: string; color?: string; bold?: boolean; dim?: boolean }

// The fill in its heat colour, the last turn's growth in red on top of it.
const meter = (percent: number | undefined, width: number, grown?: number, window?: number): Seg[] => {
  const filled = Math.min(width, Math.round(((percent ?? 0) / 100) * width))
  const fresh =
    grown && grown > 0 && window ? Math.min(filled, Math.max(1, Math.round((grown / window) * width))) : 0
  return [
    { text: '▰'.repeat(filled - fresh), color: heat(percent) },
    { text: '▰'.repeat(fresh), color: 'error' },
    { text: '▱'.repeat(width - filled), dim: true },
  ].filter(s => s.text.length > 0)
}

const point = (n: number) => n.toFixed(1)

// The grey ` +0.4` after a limit's percentage.
const nudge = (value: number | undefined): Seg[] =>
  value === undefined ? [] : [{ text: ` ${signed(value, point)}`, dim: true }]

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tokens',
      description: 'Show or hide the token display; `/tokens compact` or `/tokens expanded` picks the view',
      argumentHint: '[compact|expanded]',
    })
    void measure($)

    return next(e)
  })

  on('command.run', { command: 'tokens' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'compact' || arg === 'expanded') {
      await update($, view, () => arg)
      await update($, isHidden, () => false)
      return { text: `Tokens: ${arg} view.` }
    }
    if (arg !== '') return { text: 'Usage: /tokens [compact|expanded]' }

    const hidden = await update($, isHidden, h => !h)
    return { text: `Tokens ${hidden ? 'hidden' : 'shown'}.` }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    const done = await read($, turns)
    const n = (done.at(-1)?.n ?? 0) + 1
    const base = toBase(await read($, meters))
    await update($, live, () => ({ turnId: e.turnId, n, base, fresh: 0, cacheRead: 0, out: 0 }))

    return next(e)
  })

  // Every model request, the main loop's and each subagent's, adds to the turn
  // in flight; one that lands after the turn ended goes to the last turn.
  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    if (response.usage) {
      const spend = toSpend(response.usage)
      const current = await read($, live)
      if (current) {
        await update($, live, now => now && add(now, spend))
      } else {
        await update($, turns, list =>
          list.length === 0 ? list : [...list.slice(0, -1), add(list.at(-1) as Turn, spend)],
        )
      }
    }

    return response
  })

  on('turn.complete', async ($, e, next) => {
    const current = await read($, live)
    // Any main-loop end closes the open turn, so none is left looking live.
    if (e.agentId !== undefined || !current) return next(e)

    // No request reached the steps hook (it loaded mid-turn): use the turn's own sum.
    const spend: Spend = delta(current) === 0 && e.usage ? add(current, toSpend(e.usage)) : current
    const after = await measure($)
    const turn = withDeltas(
      {
        n: current.n,
        base: current.base,
        fresh: spend.fresh,
        cacheRead: spend.cacheRead,
        out: spend.out,
        durationMs: e.durationMs,
        isAborted: e.isAborted,
      },
      after,
    )
    await update($, turns, list => [...list, turn].slice(-KEEP))
    await update($, live, () => null)

    return next(e)
  })

  // The limits report a moment after the turn: settle the last turn's deltas
  // against them until the next turn starts.
  on('session.measure', async ($, e, next) => {
    const m = toMeters(e)
    await update($, meters, () => m)
    if ((await read($, live)) === null) {
      await update($, turns, list =>
        list.length === 0 ? list : [...list.slice(0, -1), withDeltas(list.at(-1) as Turn, m)],
      )
    }

    return next(e)
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    if (await read($, isHidden)) return next(e)
    const isCard = (await read($, view)) === 'expanded'

    const m = await read($, meters)
    const running = e.props.isWorking ? await read($, live) : null
    const done = await read($, turns)
    const last = done.at(-1)
    if (!m && !running && !last) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const room = e.props.bodyColumns
    const shown = running ?? last
    // The last turn's changes ride inline on the meters; none while one runs.
    const settled = running ? undefined : last

    const segs = (list: Seg[]) =>
      list.map(s => (
        <Text color={s.color} bold={s.bold} dimColor={s.dim} wrap="truncate-end">
          {s.text}
        </Text>
      ))

    const theDelta: Seg[] = shown
      ? [
          { text: 'Δ ', dim: true },
          { text: signed(delta(shown)), bold: true, color: running ? 'claude' : 'text' },
        ]
      : []
    const cache: Seg[] = shown ? [{ text: `  ${fmt(shown.cacheRead)} cached`, dim: true }] : []

    if (isCard) {
      // Two borderless rows, right-aligned above the prompt: the delta with the
      // recent turns' sparkline, then the meters with their inline changes.
      const limit = (label: string, l: { percent: number } | undefined, d?: number): Seg[] =>
        l ? [{ text: label, dim: true }, { text: pct(l.percent), color: heat(l.percent) }, ...nudge(d)] : []
      const recent = done.slice(-12)
      const peak = Math.max(1, ...recent.map(delta))
      const spark = recent.map(t => '▁▂▃▄▅▆▇█'[Math.min(7, Math.floor((delta(t) / peak) * 7.999))]).join('')

      const top: Seg[] = [
        ...(spark.length > 1 ? [{ text: spark, color: 'claude' }, { text: '  ' }] : []),
        ...(theDelta.length ? [...theDelta, ...cache] : [{ text: 'waiting…', dim: true }]),
      ]
      const bottom: Seg[] = m
        ? [
            { text: 'ctx ', dim: true },
            ...meter(m.ctxPercent, 10, settled?.ctxDelta, m.ctxWindow),
            { text: ` ${m.ctxPercent ?? 0}%` },
            ...limit('   5h ', m.five, settled?.fiveDelta),
            ...limit('   wk ', m.week, settled?.weekDelta),
          ]
        : []

      return (
        <Box flexDirection="column" alignItems="flex-end" width={room}>
          <Box flexDirection="row">{segs(top)}</Box>
          {bottom.length > 0 && <Box flexDirection="row">{segs(bottom)}</Box>}
        </Box>
      )
    }

    const gauges = (withDeltas: boolean): Seg[] => {
      if (!m) return []
      const d = withDeltas ? settled : undefined
      return [
        { text: 'ctx ', dim: true },
        ...meter(m.ctxPercent, 8, d?.ctxDelta, m.ctxWindow),
        { text: ` ${m.ctxPercent ?? 0}%` },
        ...(m.five
          ? [{ text: ' · 5h ', dim: true }, { text: pct(m.five.percent), color: heat(m.five.percent) }, ...nudge(d?.fiveDelta)]
          : []),
        ...(m.week
          ? [{ text: ' · wk ', dim: true }, { text: pct(m.week.percent), color: heat(m.week.percent) }, ...nudge(d?.weekDelta)]
          : []),
        { text: '  │  ', dim: true },
      ]
    }

    // Drop from the right until it fits: cache reads, the inline deltas, then the meters.
    const width = (list: Seg[]) => list.reduce((sum, s) => sum + s.text.length, 0)
    const line =
      [
        [...gauges(true), ...theDelta, ...cache],
        [...gauges(true), ...theDelta],
        [...gauges(false), ...theDelta],
      ].find(l => width(l) <= room) ?? theDelta

    return (
      <Box flexDirection="row" justifyContent="flex-end" width={room}>
        {segs(line)}
      </Box>
    )
  })
}
