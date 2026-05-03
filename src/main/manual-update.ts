import { existsSync } from 'fs'

// dpkg writes /var/lib/dpkg/info/<package>.list when a .deb is installed,
// listing every file the package owns. Presence of our package's .list is
// the canonical signal that this build came from a .deb and therefore
// can't auto-install (electron-updater silently no-ops because dpkg needs
// root). The package name comes from electron-builder's deb output
// (`harness`); update if the .deb package id changes.
const DPKG_LIST_PATH = '/var/lib/dpkg/info/harness.list'

/** True when the running build can't auto-install a downloaded update and
 *  the user must fetch the new artifact themselves. */
export function isManualUpdateInstallType(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  fileExists: (p: string) => boolean = existsSync
): boolean {
  if (platform !== 'linux') return false
  if (env.APPIMAGE) return false
  if (fileExists(DPKG_LIST_PATH)) return true
  if (env.FLATPAK_ID) return true
  if (env.SNAP) return true
  return true
}
