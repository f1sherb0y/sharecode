import { lazy, startTransition, Suspense, useEffect, useRef, useState } from 'react'
import { HashRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { Spinner } from '@/components/ui/spinner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { queryClient } from '@/lib/query-client'
import { useAuthStore } from '@/stores/auth'
import { useThemeStore } from '@/stores/theme'
import { useConnectionStore } from './connection'
import { ClientHome, type HomeNotice } from './home'
import { loadSavedSession, rememberGuestSessions, restoreSavedSession } from './session'
import { TitleBar } from './title-bar'
import { EditorToolbarTarget } from '@/components/features/editor-toolbar'
import { startUpdateChecks } from './updater'
import { useWindowPreferences } from './window'

// The web app's own share and room pages, so the room stays identical to the site.
const SharePage = lazy(() => import('@/pages/share').then((module) => ({ default: module.SharePage })))
const EditorPage = lazy(() => import('@/pages/editor').then((module) => ({ default: module.EditorPage })))

const APP_NAME = 'ShareCode'

function Loading() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <Spinner size="lg" />
    </div>
  )
}

function ShareRoute() {
  const { shareToken } = useParams()
  return <SharePage key={shareToken} />
}

// Same rules as the web's RoomRoute/RoomEditor; without a seat the client goes back to its start screen.
function RoomRoute() {
  const { roomId } = useParams()
  const actorType = useAuthStore((state) => state.actorType)
  const isLoading = useAuthStore((state) => state.isLoading)
  const isInitialized = useAuthStore((state) => state.isInitialized)
  const sessionId = useAuthStore((state) => state.sessionId)

  if (!isInitialized || isLoading) return <Loading />
  if (actorType === null) return <Navigate to="/" replace />
  // Identity changes must tear down editor bindings and pending requests.
  return <EditorPage key={`${roomId}:${sessionId}`} />
}

function useWindowTitle(): string {
  const { pathname } = useLocation()
  const roomName = useAuthStore((state) => state.guestProfile?.room.name)
  return pathname.startsWith('/room/') && roomName ? `${roomName} - ${APP_NAME}` : APP_NAME
}

/** On launch, reopens the room of a seat kept from an earlier run (invitations are single-use). */
function useSavedSessionRestore(setNotice: (notice: HomeNotice) => void): boolean {
  const navigate = useNavigate()
  const navigateRef = useRef(navigate)
  const started = useRef(false)
  const [ready, setReady] = useState(() => !loadSavedSession())

  useEffect(() => {
    navigateRef.current = navigate
  }, [navigate])

  // Runs once per launch: navigating changes `navigate`, which must not restart the restore.
  useEffect(() => {
    if (started.current) return
    started.current = true

    const saved = loadSavedSession()
    if (!saved) {
      // Share and room pages need a server and a session check, which start from the home screen.
      navigateRef.current('/', { replace: true })
      return
    }

    void (async () => {
      let result: Awaited<ReturnType<typeof restoreSavedSession>>
      try {
        await useConnectionStore.getState().connect()
        result = await restoreSavedSession(saved)
      } catch {
        result = 'unreachable'
      }

      const room = useAuthStore.getState().guestProfile?.room
      // React Router navigates in a transition; showing the routes in the same transition
      // keeps the spinner up until the destination renders (no flash of the start screen).
      startTransition(() => {
        if (result === 'restored' && room) {
          navigateRef.current(`/room/${room.id}`, { replace: true })
        } else {
          setNotice(result === 'expired' ? 'expired' : 'unreachable')
          navigateRef.current('/', { replace: true })
        }
        setReady(true)
      })
    })()
  }, [setNotice])

  return ready
}

function ClientShell() {
  const theme = useThemeStore((state) => state.theme)
  const textOpacity = useWindowPreferences((state) => state.textOpacity)
  const backgroundOpacity = useWindowPreferences((state) => state.backgroundOpacity)
  const [notice, setNotice] = useState<HomeNotice>(null)
  const ready = useSavedSessionRestore(setNotice)
  const title = useWindowTitle()
  const [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // Text and background fade independently; client.css applies both, menus and dialogs included.
  useEffect(() => {
    const { style } = document.body
    style.setProperty('--client-text-alpha', String(textOpacity))
    style.setProperty('--client-bg-alpha', String(backgroundOpacity))
  }, [textOpacity, backgroundOpacity])

  useEffect(() => rememberGuestSessions(), [])

  useEffect(() => startUpdateChecks(), [])

  return (
    <EditorToolbarTarget.Provider value={toolbarTarget}>
      <div className="client-shell">
        <TitleBar title={title} toolbarRef={setToolbarTarget} />
        <main className="client-content">
          {ready ? (
            <Suspense fallback={<Loading />}>
              <Routes>
                <Route path="/" element={<ClientHome notice={notice} />} />
                <Route path="/s/:shareToken" element={<ShareRoute />} />
                <Route path="/room/:roomId" element={<RoomRoute />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
          ) : (
            <Loading />
          )}
        </main>
      </div>
    </EditorToolbarTarget.Provider>
  )
}

export function ClientApp() {
  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <TooltipProvider>
          <ClientShell />
          <Toaster />
        </TooltipProvider>
      </HashRouter>
    </QueryClientProvider>
  )
}
