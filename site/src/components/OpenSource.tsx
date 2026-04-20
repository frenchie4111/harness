export function OpenSource() {
  return (
    <section className="max-w-3xl mx-auto px-6 py-20 text-center">
      <div className="flex items-center justify-center gap-3 mb-6">
        <svg
          className="w-8 h-8 text-ink-400"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
        </svg>
        <h2 className="text-3xl font-bold">Open source, for real</h2>
      </div>
      <p className="text-ink-400 leading-relaxed max-w-xl mx-auto mb-2">
        Harness is MIT licensed. Use it, fork it, modify it — no strings attached. This is a passion
        project, not a business. It will never become paid or freemium.
      </p>
      <p className="text-ink-500 text-sm mb-8">
        Contributions welcome — bug reports, PRs, feature ideas, all of it.
      </p>
      <a
        href="https://github.com/frenchie4111/harness"
        className="inline-flex items-center gap-2 px-6 py-2.5 border border-ink-700 hover:border-ink-600 rounded-lg font-semibold transition-colors"
      >
        <svg
          className="w-5 h-5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
        </svg>
        View on GitHub
      </a>
    </section>
  )
}
