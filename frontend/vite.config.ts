import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { sessionPlayerPlugin } from './tooling/session-player'
import { analyzer } from 'vite-bundle-analyzer'
import { resolve, join } from 'path'
import { readdirSync, readFileSync, createReadStream } from 'node:fs'

const host = process.env.TAURI_DEV_HOST

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const backendUrl = env.VITE_API_URL || 'http://localhost:3001'
  const shouldAnalyze = process.env.ANALYZE === 'true'

  return {
    plugins: [
      sessionPlayerPlugin(),
      {
        name: 'canvas-font-assets',
        generateBundle() {
          const root = resolve(__dirname, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts')
          const emit = (dir: string, relative = '') => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              const name = join(relative, entry.name)
              if (entry.isDirectory()) emit(join(dir, entry.name), name)
              else this.emitFile({ type: 'asset', fileName: `excalidraw/fonts/${name}`, source: readFileSync(join(dir, entry.name)) })
            }
          }
          emit(root)
        },
        configureServer(server) {
          server.middlewares.use('/excalidraw/fonts', (req, res, next) => {
            const path = (req.url ?? '').split('?')[0]
            if (!/^\/[a-zA-Z0-9_./-]+\.woff2$/.test(path) || path.includes('..')) return next()
            const stream = createReadStream(resolve(__dirname, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts') + path)
            stream.on('error', () => { res.statusCode = 404; res.end() })
            res.setHeader('Content-Type', 'font/woff2')
            stream.pipe(res)
          })
        },
      },
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
