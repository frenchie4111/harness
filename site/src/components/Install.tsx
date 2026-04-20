import pkg from '../../../package.json'

const VERSION = (pkg as { version: string }).version

export function Install() {
  return (
    <section id="install" className="max-w-3xl mx-auto px-6 py-20">
      <h2 className="text-4xl font-bold text-center mb-4">Download</h2>
      <p className="text-ink-500 text-center mb-12">
        Pick your Mac architecture. Drag the app to Applications, launch, and you're done.
      </p>

      <a
        href={`https://github.com/frenchie4111/harness/releases/latest/download/Harness-${VERSION}-arm64.dmg`}
        className="block p-8 bg-white hover:bg-ink-200 text-ink-950 rounded-xl transition-colors group text-center"
      >
        <div className="text-xs text-ink-500 mb-2 uppercase tracking-wider">M1 / M2 / M3 / M4</div>
        <div className="text-3xl font-bold mb-2">Download for Apple Silicon</div>
        <div className="text-xs text-ink-500 font-mono">Harness-arm64.dmg</div>
      </a>

      <div className="mt-4 text-center">
        <a
          href={`https://github.com/frenchie4111/harness/releases/latest/download/Harness-${VERSION}.dmg`}
          className="text-sm text-ink-500 hover:text-ink-300 underline transition-colors"
        >
          On an Intel Mac? Download the x86_64 build
        </a>
      </div>

      <div className="mt-8 text-center">
        <a
          href="https://github.com/frenchie4111/harness/releases"
          className="text-sm text-ink-500 hover:text-ink-300 underline transition-colors"
        >
          Browse all releases on GitHub
        </a>
      </div>

      <div className="mt-12 p-6 bg-ink-950 border border-ink-800 rounded-xl">
        <div className="text-sm font-semibold text-ink-300 mb-3">After install</div>
        <ol className="text-sm text-ink-500 space-y-2 list-decimal pl-5">
          <li>Pick a git repository when Harness asks.</li>
          <li>
            Click the gear icon to paste a GitHub personal access token (optional, needed for PR
            status).
          </li>
          <li>
            Click <strong className="text-ink-300">Enable</strong> on the hooks banner so Claude
            status detection works.
          </li>
        </ol>
        <div className="text-xs text-ink-600 mt-4">
          Requires <code className="bg-ink-900 px-1 rounded">claude</code> CLI installed and{' '}
          <code className="bg-ink-900 px-1 rounded">git</code> on your PATH.
        </div>
      </div>
    </section>
  )
}
