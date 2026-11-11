// The released client's identity is used only by build-windows.ps1 -Release and
// build-macos.sh --release.
// Every other build is a development client that installs beside it.
const release = process.env.SHARECODE_MYGO_RELEASE_BUILD === '1'

const displayName = release ? 'ShareCode Client' : 'ShareCode Client (MyGo Development)'

export default {
  name: release ? 'sharecode-client' : 'sharecode-client-mygo-dev',
  slug: release ? 'sharecode-client' : 'sharecode-client-mygo-dev',
  identifier: release ? 'dev.sharecode.client' : 'dev.sharecode.client.mygo-dev',
  version: process.env.SHARECODE_MYGO_VERSION || '0.2.7',
  publisher: 'ShareCode',
  buildCommand: 'bun run --cwd .. client:mygo:frontend && node prepare-frontend.mjs',
  bindings: 'bindings.generated.ts',
  out: '../../build/mygo-client',
  icon: '../src-tauri/icons/128x128@2x.png',
  windows: {
    displayName,
    installDirName: release ? 'ShareCode Client' : 'ShareCode Client MyGo Development',
  },
  // The executable keeps the Tauri client's name (Contents/MacOS/sharecode-client), which an
  // installed client runs to restart after an update; build-macos.sh names the bundle.
  macos: {
    icon: '../src-tauri/icons/icon.icns',
    minimumSystemVersion: '12.0',
    infoPlist: {
      CFBundleName: displayName,
      CFBundleDisplayName: displayName,
      LSApplicationCategoryType: 'public.app-category.productivity',
      // No Dock or Cmd+Tab entry at launch; the 任务栏隐藏 switch can restore it.
      LSUIElement: true,
    },
  },
}
