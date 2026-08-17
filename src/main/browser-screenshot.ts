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

/** Why a tab can't be captured at all, or null when its viewport is usable.
 *
 * A view that has never been laid out reports 0×0 bounds, which used to yield
 * an empty NativeImage and a 200 response carrying an empty string.
 */
export function viewportCaptureError(bounds: {
  width: number
  height: number
}): string | null {
  if (!(bounds.width >= 1) || !(bounds.height >= 1)) {
    return `tab viewport is ${bounds.width}x${bounds.height} — nothing to capture`
  }
  return null
}

/** Why an encoded capture is unusable, or null when it looks like a real image. */
export function encodedCaptureError(
  size: { width: number; height: number },
  byteLength: number
): string | null {
  if (size.width < 1 || size.height < 1) {
    return `capture returned a ${size.width}x${size.height} image`
  }
  if (byteLength < 1) return 'capture encoded to 0 bytes'
  return null
}
