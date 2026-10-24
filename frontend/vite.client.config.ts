import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import { canvasFontPlugin } from './tooling/canvas-font'
import { clientScopeGuard } from './tooling/client-scope'

// The customer desktop client (src-tauri-client): client.html -> src/client, reusing the site's
// share and room pages. Build settings mirror vite.config.ts; keep the two in step.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const backendUrl = env.VITE_API_URL || 'http://localhost:3001'
  const host = process.env.TAURI_DEV_HOST

  return {
    plugins: [canvasFontPlugin(), react(), tailwindcss(), clientScopeGuard(resolve(__dirname, 'src'))],

    resolve: {
      alias: [
        // Owner-only UI that a guest can never open is replaced by an empty stub.
        {
          find: /^@\/components\/features\/share-link-manager$/,
          replacement: resolve(__dirname, 'src/client/stubs/share-link-manager.tsx'),
        },
        { find: '@', replacement: resolve(__dirname, './src') },
      ],
    },

    // Same as vite.config.ts, so Canvas also opens from a fresh dev cache.
    optimizeDeps: {
      exclude: ['@excalidraw/excalidraw'],
      include: [
        '@braintree/sanitize-url', 'es6-promise-pool', 'fuzzy',
        'lodash.debounce', 'lodash.throttle', 'png-chunk-text',
        'png-chunks-encode', 'png-chunks-extract', 'image-blob-reduce', 'pica',
      ].map(dependency => `@excalidraw/excalidraw > ${dependency}`),
    },

    clearScreen: false,
    // The site's favicons and manifest are not used by the desktop client.
    publicDir: false,

    server: {
      port: 5174,
      strictPort: true,
      host: host || false,
      hmr: host ? { protocol: 'ws', host, port: 5175 } : undefined,
      watch: {
        ignored: ['**/src-tauri/**', '**/src-tauri-client/**'],
      },
      // In a plain browser the client uses relative URLs, like the web app.
      proxy: {
        '/api': {
          target: backendUrl,
          changeOrigin: true,
          ws: true,
        },
      },
    },

    build: {
      outDir: 'dist-client',
      emptyOutDir: true,
      target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
      minify: !process.env.TAURI_ENV_DEBUG ? 'oxc' : false,
      sourcemap: !!process.env.TAURI_ENV_DEBUG,
      rollupOptions: {
        input: resolve(__dirname, 'client.html'),
        output: {
          name: 'ShareCodeClient',
        },
      },
    },

    worker: {
      rollupOptions: {
        output: {
          name: 'ShareCodeClientWorker',
        },
      },
    },

    envPrefix: ['VITE_', 'TAURI_'],
  }
})
