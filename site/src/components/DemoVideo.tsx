export function DemoVideo() {
  return (
    <section className="max-w-6xl mx-auto px-6 pb-24">
      <video
        autoPlay
        loop
        muted
        playsInline
        preload="metadata"
        poster="/harness-demo-poster.jpg"
        className="w-full rounded-xl border border-ink-800 shadow-2xl shadow-black/60"
      >
        <source src="/harness-demo.mp4" type="video/mp4" />
      </video>
    </section>
  )
}
