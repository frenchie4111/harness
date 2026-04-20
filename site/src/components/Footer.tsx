export function Footer() {
  return (
    <footer className="border-t border-ink-900 mt-20">
      <div className="max-w-6xl mx-auto px-6 py-10 flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-ink-600">
        <div className="flex items-center gap-2">
          <img src="/icon.png" alt="" className="w-5 h-5 rounded" />
          <span>Harness · Open source · MIT</span>
        </div>
        <div className="flex items-center gap-6">
          <a
            href="https://github.com/frenchie4111/harness"
            className="hover:text-ink-300 transition-colors"
          >
            GitHub
          </a>
          <a
            href="https://github.com/frenchie4111/harness/issues"
            className="hover:text-ink-300 transition-colors"
          >
            Issues
          </a>
          <a href="/releases.html" className="hover:text-ink-300 transition-colors">
            Release notes
          </a>
          <a
            href="https://github.com/frenchie4111/harness/releases"
            className="hover:text-ink-300 transition-colors"
          >
            Downloads
          </a>
        </div>
      </div>
    </footer>
  )
}
