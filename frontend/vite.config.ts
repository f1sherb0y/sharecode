import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { sessionPlayerPlugin } from './tooling/session-player'
import { analyzer } from 'vite-bundle-analyzer'
import { resolve } from 'path'
import { canvasFontPlugin } from './tooling/canvas-font'

const host = process.env.TAURI_DEV_HOST

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const backendUrl = env.VITE_API_URL || 'http://localhost:3001'
  const shouldAnalyze = process.env.ANALYZE === 'true'

  return {
    plugins: [
      sessionPlayerPlugin(),
      canvasFontPlugin(),
      react(),
      tailwindcss(),
      analyzer({
        enabled: shouldAnalyze,
        analyzerMode: 'static',
        fileName: 'bundle-report',
        openAnalyzer: false,
        defaultSizes: 'gzip',
        summary: true,
      }),
    ],

    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
      },
    },

    // Keep the font adapter active in development as well as production.
    optimizeDeps: {
      exclude: ['@excalidraw/excalidraw'],
      // Excluded ESM still imports CommonJS helpers; prebundle those explicitly
      // so a fresh dev cache can open Canvas without missing-default errors.
      include: [
        '@braintree/sanitize-url', 'es6-promise-pool', 'fuzzy',
        'lodash.debounce', 'lodash.throttle', 'png-chunk-text',
        'png-chunks-encode', 'png-chunks-extract', 'image-blob-reduce', 'pica',
      ].map(dependency => `@excalidraw/excalidraw > ${dependency}`),
    },

    clearScreen: false,

    server: {
      port: 5173,
      strictPort: true,
      host: true, // Expose to LAN
      hmr: host ? { protocol: 'ws', host, port: 5173 } : undefined,
      watch: {
        ignored: ['**/src-tauri/**'],
      },
      proxy: {
        '/api': {
          target: backendUrl,
          changeOrigin: true,
          ws: true,
        },
      },
    },

    build: {
      target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
      minify: !process.env.TAURI_ENV_DEBUG ? 'oxc' : false,
      sourcemap: !!process.env.TAURI_ENV_DEBUG,
      rollupOptions: {
        output: {
          name: 'ShareCodeApp',
        },
      },
    },

    worker: {
      rollupOptions: {
        output: {
          name: 'ShareCodeWorker',
        },
      },
    },

    envPrefix: ['VITE_', 'TAURI_'],
  }
})
