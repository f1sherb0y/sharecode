import { create } from 'zustand'
import { selectFastestNode, webSocketOrigin, type FastestNode, type NodeProbe } from './nodes'

// Inside Tauri the shared API and WebSocket clients read their server from this key (api/client.ts).
const SERVER_SETTINGS_KEY = 'sharecode_settings'

interface ConnectionState {
  server: FastestNode | null
  probes: Record<string, NodeProbe>
  isConnecting: boolean
  /** Picks the fastest node and points the app at it. Rejects with NodesUnreachableError. */
  connect: () => Promise<FastestNode>
}

let pending: Promise<FastestNode> | undefined

export const useConnectionStore = create<ConnectionState>()((set) => ({
  server: null,
  probes: {},
  isConnecting: false,

  connect: () => {
    pending ??= (async () => {
      set({ isConnecting: true, probes: {} })
      try {
        const server = await selectFastestNode((probe) =>
          set((state) => ({ probes: { ...state.probes, [probe.node]: probe } }))
        )
        localStorage.setItem(
          SERVER_SETTINGS_KEY,
          JSON.stringify({ serverUrl: server.node, wsUrl: webSocketOrigin(server.node) })
        )
        set({ server })
        return server
      } finally {
        set({ isConnecting: false })
        pending = undefined
      }
    })()
    return pending
  },
}))
