// Cross-process type for the Codex plugin install / probe result.
// Defined in shared/ so both the main-process producer
// (src/main/codex-plugin.ts) and the renderer-process consumer
// (Settings card, banner) can reference one interface without coupling
// the renderer to main internals.

export interface CodexPluginVerification {
  /** True iff every assertion below also passed. */
  ok: boolean
  /** `codex plugin list --marketplace harness` shows the plugin as
   *  `installed, enabled`. */
  pluginEnabled: boolean
  /** The plugin cache materialized hooks/hooks.json. */
  hooksPresent: boolean
  /** Codex has persisted trust hashes (`trusted_hash = "sha256:…"` in
   *  ~/.codex/config.toml `[hooks.state]`) covering every event in the
   *  plugin's hooks.json. Plugin install does NOT auto-trust — Codex
   *  skips untrusted plugin hooks until the user accepts the TUI
   *  "Hooks need review / Trust all and continue" prompt on first
   *  launch. There's no CLI command to grant trust, so when this is
   *  false the user must open a Codex session interactively. */
  hooksTrusted: boolean
  /** Free-form note for surfacing in the UI when one of the assertions
   *  fails (e.g. raw stderr from a failed `codex plugin add`). */
  message?: string
}
