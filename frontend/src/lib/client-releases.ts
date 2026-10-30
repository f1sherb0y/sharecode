import { CLIENT_PLATFORMS, type ClientAssetKind, type ClientDownload, type ClientPlatform, type ClientReleaseAsset } from '@/types'

type Translate = (key: string) => string

export function osLabel(t: Translate, platform: ClientPlatform): string {
  return t(`clientPlatforms.os.${platform.split('-')[0]}`)
}

/** The architecture as people know it: x64, ARM64, Apple silicon, Intel. */
export function archLabel(t: Translate, platform: ClientPlatform): string {
  return t(`clientPlatforms.arch.${platform}`)
}

export function platformLabel(t: Translate, platform: ClientPlatform): string {
  return `${osLabel(t, platform)} · ${archLabel(t, platform)}`
}

/** Whether installed clients on the platform can update to a release with these files: a signed
 * update bundle, or on Windows and Linux a signed installer (the server picks updates the same way). */
export function hasUpdateFor(assets: ClientReleaseAsset[], platform: ClientPlatform): boolean {
  return assets.some((asset) =>
    asset.platform === platform && asset.signed && (asset.kind === 'update' || !platform.startsWith('darwin-')))
}

interface UserAgentData {
  mobile: boolean
  platform: string
  getHighEntropyValues(hints: string[]): Promise<{ architecture?: string }>
}

/** The visitor's platform for the download button: 'mobile' on phones and tablets, null when
 * unknown. User-Agent Client Hints (Chromium browsers) report the real architecture; the user
 * agent string does not, where Windows and Linux on Arm say so and Macs always claim Intel. */
export async function detectPlatform(): Promise<ClientPlatform | 'mobile' | null> {
  const nav = navigator as Navigator & { userAgentData?: UserAgentData }
  const data = nav.userAgentData
  if (data) {
    if (data.mobile || data.platform === 'Android') return 'mobile'
    const os = ({ Windows: 'windows', macOS: 'darwin', Linux: 'linux' } as Record<string, string>)[data.platform]
    if (os) {
      let architecture: string | undefined
      try {
        architecture = (await data.getHighEntropyValues(['architecture'])).architecture
      } catch { /* hints refused */ }
      // Without the hint a Mac is most likely Apple silicon (every Mac sold since 2020).
      const arm = architecture ? architecture === 'arm' : os === 'darwin'
      return `${os}-${arm ? 'aarch64' : 'x86_64'}` as ClientPlatform
    }
  }

  const ua = nav.userAgent
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return 'mobile'
  if (/Windows NT/i.test(ua)) return /ARM64|aarch64/i.test(ua) ? 'windows-aarch64' : 'windows-x86_64'
  // iPadOS Safari presents itself as a Mac; only touch support tells them apart.
  if (/Macintosh|Mac OS X/i.test(ua)) return nav.maxTouchPoints > 1 ? 'mobile' : 'darwin-aarch64'
  if (/CrOS/i.test(ua)) return null
  if (/Linux|X11/i.test(ua)) return /aarch64|arm64/i.test(ua) ? 'linux-aarch64' : 'linux-x86_64'
  return null
}

// Builds that run elsewhere: x64 apps on Windows on Arm (emulation) and Intel apps on Apple
// silicon (Rosetta). Never the other way round, and never on Linux.
const FALLBACKS: Partial<Record<ClientPlatform, ClientPlatform>> = {
  'windows-aarch64': 'windows-x86_64',
  'darwin-aarch64': 'darwin-x86_64',
}

export function pickDownload(downloads: ClientDownload[], platform: ClientPlatform | null): ClientDownload | null {
  if (!platform) return null
  const find = (target: ClientPlatform | undefined) => downloads.find((download) => download.platform === target)
  return find(platform) ?? find(FALLBACKS[platform]) ?? null
}

/** The one-line install command for the platform's system, which fetches this site's install
 * script (server-rs/src/routes/client_install) and runs it: zsh in Terminal on macOS, Windows
 * PowerShell 5.1 (every Windows 10 and 11 has it) from Win+R, cmd or PowerShell on Windows. */
export function installCommand(platform: ClientPlatform, origin: string): string | null {
  if (platform.startsWith('darwin-')) return `/bin/zsh -c "$(curl -fsSL ${origin}/api/client/install.sh)"`
  if (platform.startsWith('windows-')) {
    return `powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=3072;irm -UseBasicParsing ${origin}/api/client/install.ps1|iex"`
  }
  return null
}

export function sortByPlatform<T extends { platform: ClientPlatform }>(items: T[]): T[] {
  return [...items].sort((a, b) => CLIENT_PLATFORMS.indexOf(a.platform) - CLIENT_PLATFORMS.indexOf(b.platform))
}

/** The platform and kind a Tauri bundle's file name implies, for the upload form. The macOS
 * update bundle (`<App>.app.tar.gz`) and universal builds name no architecture. */
export function inferAsset(fileName: string): { platform: ClientPlatform | null; kind: ClientAssetKind } {
  const name = fileName.toLowerCase()
  const arch = /aarch64|arm64/.test(name) ? 'aarch64' : /x64|x86_64|amd64/.test(name) ? 'x86_64' : null
  const platform = (os: string, fallback: string | null = null) =>
    arch || fallback ? (`${os}-${arch ?? fallback}` as ClientPlatform) : null
  if (name.endsWith('.app.tar.gz')) return { platform: platform('darwin'), kind: 'update' }
  if (name.endsWith('.dmg')) return { platform: platform('darwin'), kind: 'installer' }
  if (/\.(exe|msi)$/.test(name)) return { platform: platform('windows', 'x86_64'), kind: 'installer' }
  if (/\.(appimage|deb|rpm)$/.test(name)) return { platform: platform('linux', 'x86_64'), kind: 'installer' }
  return { platform: null, kind: 'installer' }
}

/** The version in a Tauri bundle's file name (`<App>_<version>_<arch>…`), if any. */
export function fileNameVersion(fileName: string): string | null {
  return fileName.match(/_(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)_/)?.[1] ?? null
}
