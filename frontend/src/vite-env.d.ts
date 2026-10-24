/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string
  readonly VITE_WS_URL?: string
  /** Desktop client: comma-separated server origins to choose from (default kode666.com, collabcode.cc) */
  readonly VITE_CLIENT_NODES?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module 'virtual:session-player-url' { const url: string; export default url }
declare module 'virtual:replay-translations' { const resources: Record<string, { translation: Record<string, unknown> }>; export default resources }
