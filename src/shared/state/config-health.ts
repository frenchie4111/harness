// Carries a boot-time config.json load failure to the renderer so it can show
// the recovery modal. `loadError` is set only at construction (from main's
// getConfigLoadError) — there are no mutating events, so this slice has no
// reducer; recovery clears it by rebuilding state (dev) or relaunching (prod).

export interface ConfigLoadError {
  /** Human-readable parse/read error (e.g. the JSON.parse message). */
  message: string
  /** Absolute path to the config.json that failed to load. */
  configPath: string
  /** Absolute path to the quarantined copy taken before any reset, or
   *  null if the original couldn't be copied (e.g. unreadable). */
  backupPath: string | null
}

export interface ConfigHealthState {
  loadError: ConfigLoadError | null
}

export const initialConfigHealth: ConfigHealthState = {
  loadError: null
}
