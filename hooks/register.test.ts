import { expect, mock, test } from 'claude-code/testing'
import type { ModelUsage, On, RenderElement, SessionUsage, TurnStepResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const

const usageAt = (tokens: number, five: number, week: number): SessionUsage => ({
  startedAt: 0,
  context: { tokens, window: 200_000, percent: Math.round((tokens / 200_000) * 100) },
  rateLimits: [
    { kind: 'five_hour', percentUsed: five, resetsAt: '2026-10-19T18:00:00Z' },
    { kind: 'seven_day', percentUsed: week, resetsAt: '2026-10-22T00:00:00Z' },
  ],
})

const usage = (input: number, write: number, read: number, out: number) => ({
  input_tokens: input,
  cache_creation_input_tokens: write,
  cache_read_input_tokens: read,
  output_tokens: out,
  model: 'claude-opus-5-5',
})

const answer = (u: ModelUsage & { model: string }): TurnStepResult => ({
  turnId: 't1',
  index: 0,
  answer: '',
  toolUses: [],
  stopReason: 'end_turn',
  usage: u,
})

// The engine beneath the plugin: the session's figures, each model request's
// usage in order, and every event's end.
const engine = (on: On, steps: ReturnType<typeof usage>[]) => {
  const now = { usage: usageAt(40_000, 10, 5) }
  mock.clock(on, { now: Date.parse('2026-10-19T15:00:00Z') })
  on('session.usage', () => ({ value: now.usage }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* () {
    return answer(steps.shift() ?? usage(0, 0, 0, 0))
  })
  on('turn.complete', () => ({ text: '' }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as RenderElement
  })
  return now
}

const step = async ($: Engine, agentId?: string) => {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId })
  for await (const _ of stream) {
  }
  return stream.result
}

// One prompt: a main request, a subagent's, then the answer; the session's
// figures are `after` by the time the turn ends.
const runTurn = async ($: Engine, now: { usage: SessionUsage }, after: SessionUsage) => {
  await $.session.measure({ ...now.usage, changed: ['context', 'rateLimits'] })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await step($)
  await step($, 'agent-1')
  now.usage = after
  await $.turn.complete({ answer: 'ok', durationMs: 1200, isAborted: false, turnId: 't1', reason: 'answer' })
}

const band = (bodyColumns: number) => ({
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
})

const tokens = ($: Engine, args = '') =>
  $.command.run({
    command: 'tokens',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  } as never)

const fullscreen = { columns: 160, rows: 40, isFullscreen: true }

test('a turn sums its own and its subagent requests into one delta', async ($, on) => {
  const now = engine(on, [usage(100, 2_000, 30_000, 500), usage(50, 1_000, 10_000, 300)])
  await runTurn($, now, usageAt(46_200, 10.4, 5.1))
  await tokens($, 'expanded')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'token-turns', surface, ...band(140), viewport: fullscreen })
    // 100 + 2000 + 500 + 50 + 1000 + 300 = 3950
    expect(await ui.find({ type: 'Text', text: '+4k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /40k cached/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' +0.4' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' +0.1' })).toBeDefined()
    const red = (await ui.findAll({ type: 'Text', text: /^▰+$/ })).find(t => t.props.color === 'error')
    expect(red?.text).toBe('▰')
    await ui.unmount()
  }
})

test('a measure after the turn settles its rate-limit deltas', async ($, on) => {
  const now = engine(on, [usage(10, 0, 0, 10)])
  await runTurn($, now, usageAt(40_000, 10, 5))
  await $.session.measure({ ...usageAt(41_000, 11.5, 5.3), changed: ['rateLimits'] })

  const ui = await $.ui.mount({ plugin: 'token-turns', surface: 'terminal', ...band(140) })
  expect(await ui.find({ type: 'Text', text: ' +1.5' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' +0.3' })).toBeDefined()
})

test('the band keeps the delta at any width', async ($, on) => {
  const now = engine(on, [usage(1_000, 17_400, 2_000_000, 0)])
  await runTurn($, now, usageAt(46_000, 11, 5))

  for (const surface of SURFACES) {
    for (const columns of [140, 14]) {
      const ui = await $.ui.mount({ plugin: 'token-turns', surface, ...band(columns) })
      expect(await ui.find({ type: 'Text', text: '+18.4k' })).toBeDefined()
      await ui.unmount()
    }
    const wide = await $.ui.mount({ plugin: 'token-turns', surface, ...band(140) })
    expect(await wide.find({ type: 'Text', text: /2M cached/ })).toBeDefined()
    expect(await wide.find({ type: 'Text', text: ' +1.0' })).toBeDefined()
    // 6k of a 200k window on an 8-cell meter still shows one red cell
    const red = (await wide.findAll({ type: 'Text', text: /^▰+$/ })).find(t => t.props.color === 'error')
    expect(red?.text).toBe('▰')
    await wide.unmount()
  }
})

test('/tokens shows or hides the display; /tokens compact|expanded picks the view', async ($, on) => {
  const now = engine(on, [usage(100, 0, 0, 100)])
  await runTurn($, now, usageAt(41_000, 10, 5))
  const shows = async (pattern: RegExp) => {
    const ui = await $.ui.mount({ plugin: 'token-turns', surface: 'terminal', ...band(140), viewport: fullscreen })
    const found = await ui.find({ type: 'Text', text: pattern })
    await ui.unmount()
    return found !== undefined
  }
  const isBand = () => shows(/│/)
  const isAny = () => shows(/^\+200$/)

  expect(await isBand()).toBe(true)
  expect((await tokens($)).text).toBe('Tokens hidden.')
  expect(await isAny()).toBe(false)
  expect((await tokens($)).text).toBe('Tokens shown.')
  expect(await isBand()).toBe(true)

  expect((await tokens($, 'expanded')).text).toBe('Tokens: expanded view.')
  expect(await isBand()).toBe(false)
  expect(await isAny()).toBe(true)
  expect((await tokens($)).text).toBe('Tokens hidden.')
  expect(await isAny()).toBe(false)

  expect((await tokens($, 'wide')).text).toBe('Usage: /tokens [compact|expanded]')
  // picking a view while hidden shows it
  expect((await tokens($, 'compact')).text).toBe('Tokens: compact view.')
  expect(await isBand()).toBe(true)
})

test('a turn whose end carries another id still closes, and nothing looks live', async ($, on) => {
  engine(on, [usage(500, 0, 0, 371)])
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await step($)
  await $.turn.complete({ answer: 'ok', durationMs: 10, isAborted: false, turnId: 'other', reason: 'answer' })

  const ui = await $.ui.mount({ plugin: 'token-turns', surface: 'terminal', ...band(140) })
  const d = await ui.find({ type: 'Text', text: '+871' })
  expect(d?.props.color).toBe('text')
})
