/** A user-defined right-column tool, discovered from
 * `<worktree>/.harness/tools/<id>/tool.json`. The directory name is the
 * id; the manifest supplies presentation. Nothing about how the panel
 * looks comes from the script's output — the script only emits markdown
 * for the body. */
export interface ToolSpec {
  /** Directory name under `.harness/tools/`. */
  id: string
  /** Panel header text. Static so the panel has a title before the
   * script has ever run (and while it's failing). */
  title: string
  /** Script path relative to the tool directory. Defaults to `run.sh`. */
  script: string
  /** Absolute path to the tool directory, exported to the script as
   * HARNESS_TOOL_DIR. */
  dir: string
  /** `auto` re-runs on the changed-files watcher signal and the poll
   * interval; `manual` only runs on mount and on the refresh button. */
  refresh: 'auto' | 'manual'
}

export interface ToolRunResult {
  ok: boolean
  /** Script stdout. Rendered as markdown regardless of ok, so a script
   * can format its own error output. */
  markdown: string
  /** Set when the tool failed to run at all (spawn error, timeout,
   * non-zero exit with no stdout). */
  error?: string
}

export const TOOLS_DIRNAME = '.harness/tools'
export const TOOL_MANIFEST_FILENAME = 'tool.json'
export const DEFAULT_TOOL_SCRIPT = 'run.sh'
