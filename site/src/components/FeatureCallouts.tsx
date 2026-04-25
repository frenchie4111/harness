export function FeatureCallouts() {
  return (
    <section className="max-w-6xl mx-auto px-6 pb-24">
      <div className="grid md:grid-cols-2 gap-6">
        <article className="bg-ink-950/60 border border-ink-800 rounded-xl p-6 hover:border-ink-700 transition-colors flex flex-col">
          <h3 className="text-2xl font-bold mb-4">Mobile mode</h3>
          <div className="h-80 mb-5 flex items-center justify-center">
            <img
              src="/screenshot-mobile.svg"
              alt="Harness running on a phone, with sidebar of agents and a terminal pane"
              className="h-full w-auto object-contain"
              loading="lazy"
            />
          </div>
          <p className="text-sm text-ink-400 leading-relaxed">
            Control your agents from your phone. Guaranteed to be better than Claude's shitty
            remote UI.
          </p>
        </article>

        <article className="bg-ink-950/60 border border-ink-800 rounded-xl p-6 hover:border-ink-700 transition-colors flex flex-col">
          <h3 className="text-2xl font-bold mb-4">Browser control</h3>
          <div className="h-80 mb-5 flex items-center justify-center">
            <img
              src="/screenshot-browser.png"
              alt="Harness with an embedded browser tab the agent is driving"
              className="max-h-full w-auto"
              loading="lazy"
            />
          </div>
          <p className="text-sm text-ink-400 leading-relaxed">
            Give agents control of your browser. Useful for testing your code locally, or just
            ordering groceries.
          </p>
        </article>
      </div>
    </section>
  )
}
