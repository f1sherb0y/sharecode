// Every node serves the same deployment and database (see notes/multi-origin-deployment-2026-09-29.md),
// so any node can open any invitation and the choice is purely about network speed.
export const SERVER_NODES: string[] = (import.meta.env.VITE_CLIENT_NODES ?? 'https://kode666.com,https://collabcode.cc')
  .split(',')
  .map((node) => node.trim().replace(/\/+$/, ''))
  .filter(Boolean)

const PROBE_TIMEOUT_MS = 6000
// Once one node has answered, wait this long for the others before choosing.
const DECISION_GRACE_MS = 1500

export type NodeProbe =
  | { node: string; status: 'testing' }
  | { node: string; status: 'ok'; latencyMs: number }
  | { node: string; status: 'unreachable' }

export type FastestNode = { node: string; latencyMs: number }

export class NodesUnreachableError extends Error {}

export function nodeHost(node: string): string {
  try {
    return new URL(node).host
  } catch {
    return node
  }
}

export function webSocketOrigin(node: string): string {
  return node.replace(/^http/, 'ws')
}

// Share links are single-use, so a node is never tested with the invitation itself.
// An unauthenticated profile request answers 401 with CORS headers for the app origin:
// any HTTP answer proves the API is reachable from the client, and it changes no data.
async function timedRequest(node: string, signal: AbortSignal): Promise<number> {
  const startedAt = performance.now()
  const response = await fetch(`${node}/api/auth/profile`, { cache: 'no-store', credentials: 'omit', signal })
  await response.body?.cancel()
  return performance.now() - startedAt
}

async function probeNode(node: string): Promise<NodeProbe> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    // The first request pays for DNS and TLS; the second measures the round trip on the open connection.
    await timedRequest(node, controller.signal)
    const latencyMs = Math.max(1, Math.round(await timedRequest(node, controller.signal)))
    return { node, status: 'ok', latencyMs }
  } catch {
    return { node, status: 'unreachable' }
  } finally {
    clearTimeout(timeout)
  }
}

/** Tests every node in parallel and resolves with the one with the lowest round trip. */
export function selectFastestNode(onProbe?: (probe: NodeProbe) => void): Promise<FastestNode> {
  return new Promise((resolve, reject) => {
    const results = new Map<string, NodeProbe>()
    let settled = false
    let grace: ReturnType<typeof setTimeout> | undefined

    const decide = () => {
      if (settled) return
      settled = true
      clearTimeout(grace)
      const fastest = [...results.values()]
        .flatMap((probe) => (probe.status === 'ok' ? [probe] : []))
        .sort((a, b) => a.latencyMs - b.latencyMs)[0]
      if (fastest) resolve({ node: fastest.node, latencyMs: fastest.latencyMs })
      else reject(new NodesUnreachableError('No server is reachable'))
    }

    if (SERVER_NODES.length === 0) {
      decide()
      return
    }

    for (const node of SERVER_NODES) {
      onProbe?.({ node, status: 'testing' })
      void probeNode(node).then((probe) => {
        results.set(node, probe)
        onProbe?.(probe)
        if (results.size === SERVER_NODES.length) decide()
        else if (probe.status === 'ok' && !grace) grace = setTimeout(decide, DECISION_GRACE_MS)
      })
    }
  })
}
