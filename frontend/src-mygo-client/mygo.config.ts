// The released client's identity is used only by build-windows.ps1 -Release.
// Every other build is a development client that installs beside it.
const release = process.env.SHARECODE_MYGO_RELEASE_BUILD === '1'

export default {
  name: release ? 'sharecode-client' : 'sharecode-client-mygo-dev',
  slug: release ? 'sharecode-client' : 'sharecode-client-mygo-dev',
  identifier: release ? 'dev.sharecode.client' : 'dev.sharecode.client.mygo-dev',
  version: process.env.SHARECODE_MYGO_VERSION || '0.2.8',
  publisher: 'ShareCode',
  buildCommand: 'bun run --cwd .. client:mygo:frontend && node prepare-frontend.mjs',
  bindings: 'bindings.generated.ts',
  out: '../../build/mygo-client',
  icon: '../src-tauri/icons/128x128@2x.png',
  windows: {
    displayName: release ? 'ShareCode Client' : 'ShareCode Client (MyGo Development)',
    installDirName: release ? 'ShareCode Client' : 'ShareCode Client MyGo Development',
  },
}
