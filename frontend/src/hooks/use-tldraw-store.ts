import { useEffect, useMemo, useState } from 'react'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import type { TLInstancePresence, TLRecord, TLStore } from 'tldraw'
import {
  InstancePresenceRecordType,
  createPresenceStateDerivation,
  createTLStore,
  defaultShapeUtils,
  defaultUserPreferences,
  react,
  transact,
} from 'tldraw'
import { atom } from '@tldraw/state'
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

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

function createAssetStore(ydoc: Y.Doc) {
  const assets = ydoc.getMap<string>('tldraw-assets')

  return {
    async upload(asset: any, file: File) {
      const dataUrl = await fileToDataUrl(file)
      ydoc.transact(() => {
        assets.set(asset.id, dataUrl)
      })
      return { src: dataUrl }
    },
    resolve(asset: any) {
      const src = asset?.props?.src ?? asset?.src ?? ''
      if (typeof src === 'string' && src.startsWith('yjs:')) {
        return assets.get(src.slice(4)) ?? ''
      }
      return typeof src === 'string' ? src : ''
    },
    remove(asset: any) {
      ydoc.transact(() => {
        assets.delete(asset.id)
      })
    },
  }
}

export function useTldrawStore({
  ydoc,
  provider,
  isSynced,
  user,
}: UseTldrawStoreProps): TldrawStoreResult {
  const assetStore = useMemo(() => (ydoc ? createAssetStore(ydoc) : null), [ydoc])
  const store = useMemo(() => {
    if (!ydoc || !assetStore) return null
    return createTLStore({
      shapeUtils: defaultShapeUtils,
      assets: assetStore,
    })
  }, [ydoc, assetStore])
  const [ready, setReady] = useState(false)
  const clientId = provider?.awareness?.clientID?.toString()
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
    if (!ydoc || !provider || !isSynced || !store || !userAtom || !clientId) {
      setReady(false)
      return
    }

    const yRecords = ydoc.getMap<TLRecord>('tldraw-records')
    const assets = ydoc.getMap<string>('tldraw-assets')
    const unsubs: Array<() => void> = []

    const normalizeAssetRecord = (record: TLRecord) => {
      if ((record as any).typeName !== 'asset') return record
      const props = (record as any).props
      if (!props || typeof props.src !== 'string') return record
      const src = props.src as string
      if (!src.startsWith('yjs:')) return record
      const resolved = assets.get(src.slice(4)) ?? ''
      if (resolved === src) return record

      return {
        ...(record as any),
        props: {
          ...props,
          src: resolved,
        },
      } as TLRecord
    }

    // Store -> Yjs
    unsubs.push(
      store.listen(
        ({ changes }) => {
          ydoc.transact(() => {
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

    // Yjs -> Store
    const handleYjsChange = (event: Y.YMapEvent<TLRecord>) => {
      if (event.transaction.local) return

      const toRemove: TLRecord['id'][] = []
      const toPut: TLRecord[] = []

      const replacements: TLRecord[] = []
      event.changes.keys.forEach((change, key) => {
        if (change.action === 'delete') {
          toRemove.push(key as TLRecord['id'])
        } else {
          const record = yRecords.get(key)
          if (record) {
            const normalized = normalizeAssetRecord(record)
            toPut.push(normalized)
            if (normalized !== record) {
              replacements.push(normalized)
            }
          }
        }
      })

      if (!toRemove.length && !toPut.length) return

      store.mergeRemoteChanges(() => {
        if (toRemove.length) store.remove(toRemove)
        if (toPut.length) store.put(toPut)
      })

      if (replacements.length) {
        ydoc.transact(() => {
          for (const record of replacements) {
            yRecords.set(record.id, record)
          }
        })
      }
    }

    yRecords.observe(handleYjsChange)
    unsubs.push(() => yRecords.unobserve(handleYjsChange))

    // Presence
    const presenceId = InstancePresenceRecordType.createId(clientId)
    const presenceDerivation = createPresenceStateDerivation(userAtom, presenceId)(store)

    const disposePresence = react('sync presence to awareness', () => {
      const presence = presenceDerivation.get()
      if (!presence) return
      provider.awareness.setLocalStateField('presence', presence)
      const localState = provider.awareness.getLocalState() as { user?: Record<string, unknown> } | null
      const prevUser = (localState?.user ?? {}) as Record<string, unknown>
      provider.awareness.setLocalStateField('user', {
        ...prevUser,
        username: prevUser.username ?? presence.userName,
        name: prevUser.name ?? presence.userName,
        color: prevUser.color ?? presence.color,
      })
    })
    unsubs.push(disposePresence)

    const handleAwarenessUpdate = (update: { added: number[]; updated: number[]; removed: number[] }) => {
      const states = provider.awareness.getStates() as Map<number, { presence?: TLInstancePresence }>

      const toRemove: TLInstancePresence['id'][] = []
      const toPut: TLInstancePresence[] = []

      for (const id of update.added) {
        const state = states.get(id)
        if (state?.presence && state.presence.id !== presenceId) {
          toPut.push(state.presence)
        }
      }

      for (const id of update.updated) {
        const state = states.get(id)
        if (state?.presence && state.presence.id !== presenceId) {
          toPut.push(state.presence)
        }
      }

      for (const id of update.removed) {
        toRemove.push(InstancePresenceRecordType.createId(id.toString()))
      }

      if (!toRemove.length && !toPut.length) return

      store.mergeRemoteChanges(() => {
        if (toRemove.length) store.remove(toRemove)
        if (toPut.length) store.put(toPut)
      })
    }

    provider.awareness.on('update', handleAwarenessUpdate)
    unsubs.push(() => provider.awareness.off('update', handleAwarenessUpdate))

    // Initialize store from yjs or seed yjs from store
    if (yRecords.size > 0) {
      const originalRecords = Array.from(yRecords.values()) as TLRecord[]
      const normalizedRecords = originalRecords.map(normalizeAssetRecord) as TLRecord[]
      transact(() => {
        store.clear()
        store.put(normalizedRecords)
      })
      const replacements = normalizedRecords.filter((record, index) => record !== originalRecords[index])
      if (replacements.length) {
        ydoc.transact(() => {
          for (const record of replacements) {
            yRecords.set(record.id, record)
          }
        })
      }
    } else {
      ydoc.transact(() => {
        store.allRecords().forEach((record) => {
          yRecords.set(record.id, record)
        })
      })
    }

    setReady(true)

    return () => {
      unsubs.forEach((fn) => fn())
      unsubs.length = 0
      setReady(false)
    }
  }, [ydoc, provider, isSynced, store, userAtom, clientId])

  return { store, ready }
}
