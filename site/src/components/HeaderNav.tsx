export function HeaderNav() {
  return (
    <nav className="max-w-6xl mx-auto px-4 sm:px-6 py-6 flex items-center justify-between gap-4 relative z-20">
      <a href="/" className="flex items-center gap-3 min-w-0 group">
        <img
          src="/icon.png"
          alt="Harness icon"
          className="w-9 h-9 rounded-lg flex-shrink-0 transition-transform group-hover:scale-105"
        />
        <span className="text-xl font-bold tracking-tight">Harness</span>
      </a>
      <div className="flex items-center gap-4 sm:gap-6 text-sm text-ink-400 flex-shrink-0">
        <a href="#features" className="hidden sm:inline hover:text-ink-100 transition-colors">
          Features
        </a>
        <a href="/guide.html" className="hover:text-ink-100 transition-colors">
          Guide
        </a>
        <a href="#install" className="hover:text-ink-100 transition-colors">
          Install
        </a>
        <a
          href="https://github.com/frenchie4111/harness"
          className="hover:text-ink-100 transition-colors"
        >
          GitHub
        </a>
      </div>
    </nav>
  )
}
