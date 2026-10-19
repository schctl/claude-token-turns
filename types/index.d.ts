export type Limit = { percent: number; resetsAt?: string }

export type Meters = {
  ctxTokens?: number
  ctxWindow: number
  ctxPercent?: number
  five?: Limit
  week?: Limit
}

/** The meters as a turn began, to measure the turn's deltas against. */
export type Base = { ctxTokens?: number; five?: number; week?: number }

/** Token counts summed over a turn's model requests, subagents' included. */
export type Spend = { fresh: number; cacheRead: number; out: number }

export type Live = Spend & { turnId: string; n: number; base: Base | null }

export type Turn = Spend & {
  n: number
  base: Base | null
  ctxDelta?: number
  fiveDelta?: number
  weekDelta?: number
  durationMs: number
  isAborted: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'token-turns': {
      meters: Meters | null
      turns: Turn[]
      live: Live | null
      isHidden: boolean
      view: 'compact' | 'expanded'
    }
  }
}
