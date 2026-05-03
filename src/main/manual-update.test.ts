import { describe, it, expect } from 'vitest'
import { isManualUpdateInstallType } from './manual-update'

describe('isManualUpdateInstallType', () => {
  const noFiles = () => false
  const debInstalled = (p: string) => p === '/var/lib/dpkg/info/harness.list'

  it('returns false on macOS', () => {
    expect(isManualUpdateInstallType({}, 'darwin', noFiles)).toBe(false)
  })

  it('returns false on Windows', () => {
    expect(isManualUpdateInstallType({}, 'win32', noFiles)).toBe(false)
  })

  it('returns true on linux when the dpkg .list file is present', () => {
    expect(isManualUpdateInstallType({}, 'linux', debInstalled)).toBe(true)
  })

  it('returns false on linux AppImage', () => {
    expect(
      isManualUpdateInstallType({ APPIMAGE: '/tmp/Harness.AppImage' }, 'linux', noFiles)
    ).toBe(false)
  })

  it('AppImage env wins even if a stray .list file is present', () => {
    expect(
      isManualUpdateInstallType(
        { APPIMAGE: '/tmp/Harness.AppImage' },
        'linux',
        debInstalled
      )
    ).toBe(false)
  })

  it('returns true under Flatpak', () => {
    expect(
      isManualUpdateInstallType({ FLATPAK_ID: 'org.example.harness' }, 'linux', noFiles)
    ).toBe(true)
  })

  it('returns true under Snap', () => {
    expect(
      isManualUpdateInstallType({ SNAP: '/snap/harness/current' }, 'linux', noFiles)
    ).toBe(true)
  })

  it('returns true on linux with no signals (unknown packaging is treated as manual)', () => {
    expect(isManualUpdateInstallType({}, 'linux', noFiles)).toBe(true)
  })
})
