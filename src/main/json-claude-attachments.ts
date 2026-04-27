// Pasted-image attachments for JSON-mode chat. The renderer reads
// clipboard image bytes via FileReader (base64) but has no fs access to
// turn them into a real file Claude can reference. We do that here:
// write the bytes to a stable on-disk location so the model receives
// both the inline image content block AND a path it can pass to Read /
// Bash / Write tools.
//
// Storage location: under os.tmpdir() so we don't pollute any worktree
// or userData dir. macOS clears /tmp opportunistically; that's fine for
// transient chat attachments. Filename embeds a uuid so concurrent
// pastes don't collide.

import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

const ATTACHMENT_DIR = join(tmpdir(), 'harness-attachments')

const EXT_BY_MEDIA_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg'
}

/** Write a base64-encoded image to a fresh path under
 *  $TMPDIR/harness-attachments/. Returns the absolute path. Accepts the
 *  raw base64 string (no data URL prefix). */
export function writeAttachmentImage(
  base64Data: string,
  mediaType: string
): string {
  if (!existsSync(ATTACHMENT_DIR)) {
    mkdirSync(ATTACHMENT_DIR, { recursive: true, mode: 0o700 })
  }
  const ext = EXT_BY_MEDIA_TYPE[mediaType.toLowerCase()] || 'bin'
  const path = join(ATTACHMENT_DIR, `${randomUUID()}.${ext}`)
  writeFileSync(path, Buffer.from(base64Data, 'base64'), { mode: 0o600 })
  return path
}
