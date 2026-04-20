// Pure helpers for browser-manager's capturePage pipeline. Kept in its own
// module so unit tests can import them without pulling in `electron`.

// TODO(future): consider an OCR endpoint to replace screenshots for
// text-heavy use cases. Deferred by user as overkill for now.

/** Decide target CSS-pixel dimensions + an optional further downscale cap.
 *
 * `capturePage()` returns a NativeImage at the display's scaleFactor (2× on
 * Retina), but `sendInputEvent({x,y})` expects CSS pixels. Normalizing the
 * screenshot to CSS pixels means agents can pass screenshot-derived coords
 * straight to click_tab (at least when maxDimension doesn't downscale).
 */
export function resolveScreenshotTarget(
  cssBounds: { width: number; height: number },
  maxDimension?: number
): {
  cssSize: { width: number; height: number }
  outputSize: { width: number; height: number }
  scale: number
} {
  const cssSize = { width: cssBounds.width, height: cssBounds.height }
  let outputSize = cssSize
  let scale = 1
  if (maxDimension && Number.isFinite(maxDimension) && maxDimension > 0) {
    const longEdge = Math.max(cssSize.width, cssSize.height)
    if (longEdge > maxDimension) {
      scale = maxDimension / longEdge
      outputSize = {
        width: Math.max(1, Math.round(cssSize.width * scale)),
        height: Math.max(1, Math.round(cssSize.height * scale))
      }
    }
  }
  return { cssSize, outputSize, scale }
}
