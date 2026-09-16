/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string
  readonly VITE_WS_URL?: string
  readonly VITE_ALLOW_REGISTRATION?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module 'virtual:session-player-url' { const url: string; export default url }
declare module 'virtual:replay-translations' { const resources: Record<string, { translation: Record<string, unknown> }>; export default resources }
