import { useEffect, useMemo, useRef, useState } from 'react'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import type {
  SerializedSchema,
  TLInstancePresence,
  TLRecord,
  TLStore,
} from 'tldraw'
import {
  InstancePresenceRecordType,
  atom,
  createPresenceStateDerivation,
  createTLStore,
  defaultShapeUtils,
  defaultUserPreferences,
  react,
} from 'tldraw'
import * as Y from 'yjs'

interface TldrawUserInfo {
  id?: string
  username?: string
  color?: string
}

interface UseTldrawStoreProps {
  ydoc: Y.Doc | null
  provider: HocuspocusProvider | null
  isSynced: boolean
  user?: TldrawUserInfo | null
}

interface TldrawStoreResult {
  store: TLStore | null
  ready: boolean
}

const PRESENCE_BROADCAST_INTERVAL_MS = 33
const PRESENCE_ACTIVITY_BUCKET_MS = 250
const PRESENCE_VIEWPORT_INTERVAL_MS = 200
const CURSOR_ROUNDING_STEP = 0.5
const VIEWPORT_POSITION_ROUNDING_STEP = 2
const VIEWPORT_SIZE_ROUNDING_STEP = 4
const VIEWPORT_ZOOM_ROUNDING_STEP = 0.01

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

function createAssetStore() {
  return {
    async upload(_asset: unknown, file: File) {
      const dataUrl = await fileToDataUrl(file)
      return { src: dataUrl }
    },
    resolve(asset: unknown) {
      const a = asset as { props?: { src?: unknown }; src?: unknown } | null
      const src = a?.props?.src ?? a?.src ?? ''
      return typeof src === 'string' ? src : ''
    },
  }
}

export function useTldrawStore({
  ydoc,
  provider,
  isSynced,
  user,
}: UseTldrawStoreProps): TldrawStoreResult {
  const assetStore = useMemo(() => (ydoc ? createAssetStore() : null), [ydoc])
  const store = useMemo(() => {
    if (!ydoc || !assetStore) return null
    return createTLStore({
      shapeUtils: defaultShapeUtils,
      assets: assetStore,
    })
  }, [ydoc, assetStore])
  const [ready, setReady] = useState(false)
  const clientId = provider?.awareness?.clientID?.toString()
  const isSyncedRef = useRef(isSynced)
  useEffect(() => {
    isSyncedRef.current = isSynced
  }, [isSynced])
  const userAtom = useMemo(() => {
    if (!clientId) return null
    return atom('tldraw-user', {
      id: clientId,
      color: user?.color ?? defaultUserPreferences.color,
      name: user?.username ?? defaultUserPreferences.name,
    })
  }, [clientId])

  useEffect(() => {
    if (userAtom && clientId) {
      userAtom.set({
        id: clientId,
        color: user?.color ?? defaultUserPreferences.color,
        name: user?.username ?? defaultUserPreferences.name,
      })
    }
  }, [userAtom, user?.color, user?.username, clientId])

  useEffect(() => {
    const awareness = provider?.awareness
    if (!ydoc || !provider || !awareness || !store || !userAtom || !clientId) {
      setReady(false)
      return
    }

    const yRecords = ydoc.getMap<TLRecord>('tldraw-records')
    const yMeta = ydoc.getMap<SerializedSchema>('tldraw-meta')
    const unsubs: Array<() => void> = []
    let seeded = false
    // Remote Yjs changes that arrive before `doSeed` runs are buffered here
    // and drained after the initial load. We buffer pre-extracted change sets,
    // not raw YMapEvents: `event.changes` can only be computed while the
    // observer handler is still on the stack — accessing it after the handler
    // returns throws "You must not compute changes after the event-handler
    // fired". Extracting up front also lets us drop stale refs.
    type PendingChange = { toRemove: TLRecord['id'][]; toPut: TLRecord[] }
    const pendingRemote: PendingChange[] = []

    const safeMergeRemote = (fn: () => void) => {
      try {
        store.mergeRemoteChanges(fn)
      } catch (err) {
        console.error('tldraw: failed to apply remote changes', err)
      }
    }

    const extractRemoteChange = (event: Y.YMapEvent<TLRecord>): PendingChange => {
      const toRemove: TLRecord['id'][] = []
      const toPut: TLRecord[] = []

      event.changes.keys.forEach((change, key) => {
        if (change.action === 'delete') {
          toRemove.push(key as TLRecord['id'])
        } else {
          const record = yRecords.get(key)
          if (record) toPut.push(record)
        }
      })

      return { toRemove, toPut }
    }

    const applyRemoteChange = ({ toRemove, toPut }: PendingChange) => {
      if (!toRemove.length && !toPut.length) return
      safeMergeRemote(() => {
        if (toRemove.length) store.remove(toRemove)
        if (toPut.length) store.put(toPut)
      })
    }

    // Yjs -> Store. Extract synchronously; before seeding, buffer; after, apply.
    const handleYjsChange = (event: Y.YMapEvent<TLRecord>) => {
      if (event.transaction.local) return
      const change = extractRemoteChange(event)
      if (!seeded) {
        pendingRemote.push(change)
        return
      }
      applyRemoteChange(change)
    }

    yRecords.observe(handleYjsChange)
    unsubs.push(() => yRecords.unobserve(handleYjsChange))

    // Presence
    const presenceId = InstancePresenceRecordType.createId(clientId)
    const presenceDerivation = createPresenceStateDerivation(userAtom, presenceId)(store)
    const pendingPresenceByClient = new Map<number, TLInstancePresence | null>()
    let pendingPresenceFlushHandle = 0
    let pendingLocalPresence: TLInstancePresence | null = null
    let presenceBroadcastTimer: ReturnType<typeof setTimeout> | null = null
    let lastBroadcastAt = 0
    let lastViewportBroadcastAt = 0
    let lastSentPresence: TLInstancePresence | null = null
    let lastSentUserState: Record<string, unknown> | null = null

    const flushRemotePresence = () => {
      pendingPresenceFlushHandle = 0
      if (!pendingPresenceByClient.size) return

      const toRemove: TLInstancePresence['id'][] = []
      const toPut: TLInstancePresence[] = []

      pendingPresenceByClient.forEach((presence, remoteClientId) => {
        pendingPresenceByClient.delete(remoteClientId)
        const remotePresenceId = InstancePresenceRecordType.createId(remoteClientId.toString())

        if (presence == null) {
          if (store.get(remotePresenceId)) {
            toRemove.push(remotePresenceId)
          }
          return
        }

        const existing = store.get(remotePresenceId) as TLInstancePresence | undefined
        if (!existing || !presenceRecordsEqual(existing, presence)) {
          toPut.push(presence)
        }
      })

      if (!toRemove.length && !toPut.length) return

      safeMergeRemote(() => {
        if (toRemove.length) store.remove(toRemove)
        if (toPut.length) store.put(toPut)
      })
    }

    const scheduleRemotePresenceFlush = () => {
      if (pendingPresenceFlushHandle) return
      pendingPresenceFlushHandle = requestAnimationFrame(flushRemotePresence)
    }

    const flushLocalPresence = () => {
      presenceBroadcastTimer = null

      const latest = pendingLocalPresence
      if (!latest) return

      const now = Date.now()
      const sanitized = sanitizePresenceForBroadcast(
        latest,
        lastSentPresence,
        now,
        lastViewportBroadcastAt
      )
      const localState = (awareness.getLocalState() ?? {}) as {
        cursor?: unknown
        presence?: TLInstancePresence
        user?: Record<string, unknown>
      }
      const nextUserState = buildAwarenessUserState(localState.user, sanitized)
      const previousSentPresence = lastSentPresence

      const presenceChanged = !lastSentPresence || !presenceRecordsEqual(lastSentPresence, sanitized)
      const userChanged = !userStateEquals(lastSentUserState, nextUserState)

      if (presenceChanged || userChanged) {
        awareness.setLocalState({
          ...localState,
          presence: sanitized,
          user: nextUserState,
        })
        lastSentPresence = sanitized
        lastSentUserState = nextUserState
        lastBroadcastAt = now

        if (
          !previousSentPresence ||
          !cameraEquals(previousSentPresence.camera, sanitized.camera) ||
          !boxEquals(previousSentPresence.screenBounds, sanitized.screenBounds)
        ) {
          lastViewportBroadcastAt = now
        }
      }

      if (pendingLocalPresence && pendingLocalPresence !== latest) {
        scheduleLocalPresenceFlush()
      }
    }

    const scheduleLocalPresenceFlush = () => {
      if (presenceBroadcastTimer) return
      const delay = Math.max(0, lastBroadcastAt + PRESENCE_BROADCAST_INTERVAL_MS - Date.now())
      presenceBroadcastTimer = setTimeout(flushLocalPresence, delay)
    }

    const disposePresence = react('sync presence to awareness', () => {
      const presence = presenceDerivation.get()
      if (!presence) return
      pendingLocalPresence = presence
      scheduleLocalPresenceFlush()
    })
    unsubs.push(() => {
      pendingLocalPresence = null
      if (presenceBroadcastTimer) {
        clearTimeout(presenceBroadcastTimer)
        presenceBroadcastTimer = null
      }
      if (pendingPresenceFlushHandle) cancelAnimationFrame(pendingPresenceFlushHandle)
      pendingPresenceFlushHandle = 0
      pendingPresenceByClient.clear()
      disposePresence()
    })

    const handleAwarenessUpdate = (update: { added: number[]; updated: number[]; removed: number[] }) => {
      if (!seeded) return
      const states = awareness.getStates() as Map<number, { presence?: TLInstancePresence }>

      for (const id of update.added) {
        const state = states.get(id)
        if (state?.presence && state.presence.id !== presenceId) {
          pendingPresenceByClient.set(id, state.presence)
        }
      }

      for (const id of update.updated) {
        const state = states.get(id)
        if (state?.presence && state.presence.id !== presenceId) {
          pendingPresenceByClient.set(id, state.presence)
        }
      }

      for (const id of update.removed) {
        pendingPresenceByClient.set(id, null)
      }

      if (!pendingPresenceByClient.size) return
      scheduleRemotePresenceFlush()
    }

    awareness.on('update', handleAwarenessUpdate)
    unsubs.push(() => awareness.off('update', handleAwarenessUpdate))

    // Store -> Yjs — attached AFTER seed, otherwise the seed's store.put
    // would echo every record back into Yjs as if the local user drew them.
    const attachStoreListener = () => {
      unsubs.push(
        store.listen(
          ({ changes }) => {
            ydoc.transact(() => {
              // Bump the stored schema on every local write so peers on older
              // versions know a migration is needed when they reconnect.
              const currentSchema = store.schema.serialize()
              const storedSchema = yMeta.get('schema')
              if (!storedSchema || JSON.stringify(storedSchema) !== JSON.stringify(currentSchema)) {
                yMeta.set('schema', currentSchema)
              }

              Object.values(changes.added).forEach((record) => {
                yRecords.set(record.id, record)
              })

              Object.values(changes.updated).forEach(([_, record]) => {
                yRecords.set(record.id, record)
              })

              Object.values(changes.removed).forEach((record) => {
                yRecords.delete(record.id)
              })
            })
          },
          { source: 'user', scope: 'document' }
        )
      )
    }

    // Initialize store from Yjs (or seed Yjs from store). Only runs once per binding
    // lifecycle — seeded flag prevents re-running on reconnects.
    const doSeed = () => {
      if (seeded) return

      if (yRecords.size > 0) {
        const records = Array.from(yRecords.values()) as TLRecord[]
        const storedSchema = yMeta.get('schema')
        const snapshot = {
          store: Object.fromEntries(records.map((r) => [r.id, r])),
          schema: storedSchema ?? store.schema.serialize(),
        }

        try {
          // Migrate the incoming snapshot to our current schema if the writer
          // was on an older version. `loadStoreSnapshot` replaces the store
          // atomically — no clear/put window with invalid intermediate state.
          const migrated = store.schema.migrateStoreSnapshot(snapshot)
          if (migrated.type === 'error') {
            console.error('tldraw: schema migration failed', migrated.reason)
            // Fall back to a naive load so the canvas at least renders.
            store.loadStoreSnapshot(snapshot)
          } else {
            store.loadStoreSnapshot({ store: migrated.value, schema: snapshot.schema })
          }
        } catch (err) {
          console.error('tldraw: failed to load snapshot', err)
        }

        // If our schema is newer than what was persisted, write ours back so
        // subsequent peers see the migrated version.
        if (
          !storedSchema ||
          JSON.stringify(storedSchema) !== JSON.stringify(store.schema.serialize())
        ) {
          ydoc.transact(() => {
            yMeta.set('schema', store.schema.serialize())
          })
        }
      } else {
        ydoc.transact(() => {
          yMeta.set('schema', store.schema.serialize())
          store.allRecords().forEach((record) => {
            yRecords.set(record.id, record)
          })
        })
      }

      seeded = true
      attachStoreListener()

      // Drain any remote changes that arrived before seed completed.
      if (pendingRemote.length) {
        const changes = pendingRemote.splice(0)
        for (const change of changes) applyRemoteChange(change)
      }

      setReady(true)
    }

    // Seed immediately if already synced; otherwise wait for the provider's synced event.
    // isSynced is intentionally NOT a dep of this effect — we don't want a transient
    // false→true flicker (caused by a second peer connecting) to tear down and rebuild
    // all bindings. The seeded flag ensures doSeed is a no-op on re-syncs.
    if (isSyncedRef.current) {
      doSeed()
    }

    const handleSynced = ({ state }: { state: boolean }) => {
      if (state) doSeed()
    }
    provider.on('synced', handleSynced)
    unsubs.push(() => provider.off('synced', handleSynced))

    return () => {
      unsubs.forEach((fn) => fn())
      unsubs.length = 0
      pendingRemote.length = 0
      setReady(false)
    }
  }, [ydoc, provider, store, userAtom, clientId])

  return { store, ready }
}

function sanitizePresenceForBroadcast(
  presence: TLInstancePresence,
  previous: TLInstancePresence | null,
  now: number,
  lastViewportBroadcastAt: number
): TLInstancePresence {
  const cursor = presence.cursor
    ? {
        ...presence.cursor,
        x: roundToStep(presence.cursor.x, CURSOR_ROUNDING_STEP),
        y: roundToStep(presence.cursor.y, CURSOR_ROUNDING_STEP),
      }
    : null

  const camera = presence.camera
    ? {
        x: roundToStep(presence.camera.x, VIEWPORT_POSITION_ROUNDING_STEP),
        y: roundToStep(presence.camera.y, VIEWPORT_POSITION_ROUNDING_STEP),
        z: roundToStep(presence.camera.z, VIEWPORT_ZOOM_ROUNDING_STEP),
      }
    : null

  const screenBounds = presence.screenBounds
    ? {
        x: roundToStep(presence.screenBounds.x, VIEWPORT_POSITION_ROUNDING_STEP),
        y: roundToStep(presence.screenBounds.y, VIEWPORT_POSITION_ROUNDING_STEP),
        w: roundToStep(presence.screenBounds.w, VIEWPORT_SIZE_ROUNDING_STEP),
        h: roundToStep(presence.screenBounds.h, VIEWPORT_SIZE_ROUNDING_STEP),
      }
    : null

  const activityBucket =
    presence.lastActivityTimestamp == null
      ? null
      : Math.floor(presence.lastActivityTimestamp / PRESENCE_ACTIVITY_BUCKET_MS) *
        PRESENCE_ACTIVITY_BUCKET_MS

  const viewportChanged =
    !previous ||
    !cameraEquals(previous.camera, camera) ||
    !boxEquals(previous.screenBounds, screenBounds)
  const shouldRefreshViewport =
    !previous ||
    previous.currentPageId !== presence.currentPageId ||
    (viewportChanged && now - lastViewportBroadcastAt >= PRESENCE_VIEWPORT_INTERVAL_MS)

  return {
    ...presence,
    cursor,
    camera: shouldRefreshViewport ? camera : (previous?.camera ?? camera),
    screenBounds: shouldRefreshViewport ? screenBounds : (previous?.screenBounds ?? screenBounds),
    lastActivityTimestamp: activityBucket,
  }
}

function buildAwarenessUserState(
  previous: Record<string, unknown> | undefined,
  presence: TLInstancePresence
) {
  return {
    ...(previous ?? {}),
    id: presence.userId,
    username: presence.userName,
    name: presence.userName,
    color: presence.color,
  }
}

function roundToStep(value: number, step: number) {
  return Math.round(value / step) * step
}

function cameraEquals(
  left: TLInstancePresence['camera'],
  right: TLInstancePresence['camera']
) {
  return (
    left?.x === right?.x &&
    left?.y === right?.y &&
    left?.z === right?.z
  )
}

function boxEquals(
  left: TLInstancePresence['screenBounds'] | TLInstancePresence['brush'],
  right: TLInstancePresence['screenBounds'] | TLInstancePresence['brush']
) {
  return (
    left?.x === right?.x &&
    left?.y === right?.y &&
    left?.w === right?.w &&
    left?.h === right?.h
  )
}

function arrayEquals<T>(left: T[], right: T[]) {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false
  }
  return true
}

function userStateEquals(
  left: Record<string, unknown> | null,
  right: Record<string, unknown> | null
) {
  return (
    left?.id === right?.id &&
    left?.username === right?.username &&
    left?.name === right?.name &&
    left?.color === right?.color &&
    left?.colorLight === right?.colorLight
  )
}

function presenceRecordsEqual(left: TLInstancePresence | null, right: TLInstancePresence | null) {
  if (left === right) return true
  if (!left || !right) return false

  return (
    left.id === right.id &&
    left.userId === right.userId &&
    left.userName === right.userName &&
    left.color === right.color &&
    left.lastActivityTimestamp === right.lastActivityTimestamp &&
    left.currentPageId === right.currentPageId &&
    left.followingUserId === right.followingUserId &&
    left.chatMessage === right.chatMessage &&
    cameraEquals(left.camera, right.camera) &&
    boxEquals(left.screenBounds, right.screenBounds) &&
    boxEquals(left.brush, right.brush) &&
    cursorEquals(left.cursor, right.cursor) &&
    arrayEquals(left.selectedShapeIds, right.selectedShapeIds) &&
    JSON.stringify(left.scribbles) === JSON.stringify(right.scribbles) &&
    JSON.stringify(left.meta) === JSON.stringify(right.meta)
  )
}

function cursorEquals(
  left: TLInstancePresence['cursor'],
  right: TLInstancePresence['cursor']
) {
  return (
    left?.x === right?.x &&
    left?.y === right?.y &&
    left?.type === right?.type &&
    left?.rotation === right?.rotation
  )
}
