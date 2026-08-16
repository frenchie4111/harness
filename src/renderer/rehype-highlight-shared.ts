import rehypeHighlight from 'rehype-highlight'

// rehype-highlight builds a fresh lowlight registry — all 37 `common`
// highlight.js grammars — inside the attacher, and react-markdown calls
// createProcessor() in its component body with no memo. So every render of
// every markdown block re-ran 37 grammar constructors: ~4.5ms and a matching
// pile of regex garbage, per block, per streamed token. Memoizing the plugins
// array doesn't help — the cost is unified re-invoking the attacher, not
// allocating the array. The transformer is stateless, so build it once and
// hand unified a thunk that returns the same one.
const transformer = rehypeHighlight()

export const rehypeHighlightShared = (): typeof transformer => transformer
