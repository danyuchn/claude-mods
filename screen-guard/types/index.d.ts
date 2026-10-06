export type Verdicts = Record<string, number>
export type Revealed = Record<string, true>

declare module 'claude-code' {
  interface PluginState {
    'screen-guard': { enabled: boolean; verdicts: Verdicts; revealed: Revealed }
  }
}
