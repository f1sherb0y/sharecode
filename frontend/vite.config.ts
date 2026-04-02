import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { analyzer } from 'vite-bundle-analyzer'
import { resolve } from 'path'

const host = process.env.TAURI_DEV_HOST

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const backendUrl = env.VITE_API_URL || 'http://localhost:3001'
  const shouldAnalyze = process.env.ANALYZE === 'true'

  return {
    plugins: [
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
