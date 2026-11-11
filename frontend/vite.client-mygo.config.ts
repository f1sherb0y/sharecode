import { defineConfig, mergeConfig } from 'vite'
import { resolve } from 'node:path'
import clientConfig from './vite.client.config'

/** Keep the customer UI, scope guard and assets identical. Only this build replaces
 * Tauri's transport with the public runtime injected by the MyGo desktop host. */
export default defineConfig(async (env) => {
  const base = typeof clientConfig === 'function' ? await clientConfig(env) : await clientConfig
  return mergeConfig(base, {
    resolve: {
      alias: [
        { find: /^@tauri-apps\/api\/core$/, replacement: resolve(__dirname, 'src/lib/mygo-core.ts') },
        { find: /^@tauri-apps\/api\/event$/, replacement: resolve(__dirname, 'src/lib/mygo-event.ts') },
        { find: /^@tauri-apps\/api\/window$/, replacement: resolve(__dirname, 'src/lib/mygo-window.ts') },
        { find: /^@tauri-apps\/plugin-updater$/, replacement: resolve(__dirname, 'src/lib/mygo-updater.ts') },
        { find: /^@tauri-apps\/plugin-process$/, replacement: resolve(__dirname, 'src/lib/mygo-process.ts') },
        { find: /^@\/lib\/tauri$/, replacement: resolve(__dirname, 'src/lib/mygo-desktop.ts') },
      ],
    },
    plugins: [{
      name: 'mygo-no-tauri-runtime',
      generateBundle(_, bundle) {
        for (const chunk of Object.values(bundle)) {
          if (chunk.type !== 'chunk') continue
          for (const id of Object.keys(chunk.modules)) {
            if (id.replaceAll('\\', '/').includes('/@tauri-apps/')) {
              this.error(`A Tauri runtime escaped the MyGo compatibility layer: ${id}`)
            }
          }
        }
      },
    }],
    build: { outDir: 'dist-client-mygo' },
    server: { watch: { ignored: ['**/src-mygo-client/**'] } },
  })
})
