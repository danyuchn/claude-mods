export type Snap = {
  ctx: number
  model: string
  hasLimits: boolean
  fiveHour: number | null
}

export type PingInfo = {
  at: number
  read: number
  write: number
  out: number
  isWarm: boolean
}

export type Warm = {
  startedAt: number
  deadline: number
  pings: number
  /** Consecutive pings that wrote instead of read. One is tolerated: a young session's first ping writes its own entry. */
  misses: number
  last: PingInfo | null
}

declare module 'claude-code' {
  interface PluginState {
    'cache-panel': {
      nowAt: number
      lastRequestAt: number
      remindedFor: number
      isReminding: boolean
      hoursText: string
      warm: Warm | null
      snap: Snap
      note: string
    }
  }
}
