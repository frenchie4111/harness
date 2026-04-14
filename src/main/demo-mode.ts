// Module-level flag for demo mode. Set once at process start by checking
// argv / env, then read by other main-side modules to short-circuit real
// data sources (PRPoller, watchStatusDir, listWorktrees, ptyManager.create,
// persistPanes) so the DemoDriver can drive everything via store dispatches
// and direct terminal:data IPC sends.

export const isDemoMode =
  process.argv.includes('--demo') || process.env.HARNESS_DEMO === '1'
