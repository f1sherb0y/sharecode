import { useEffect, lazy, Suspense } from 'react'
import { BrowserRouter, HashRouter, Routes, Route, Navigate, useParams } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui'

import { useAuthStore, useThemeStore } from '@/stores'
import {
  isTauriApp,
  getStealthSettings,
  applyStealthSettings,
} from '@/lib/tauri'
import { queryClient } from '@/lib/query-client'
import { Spinner } from '@/components/ui'
import { Toaster } from 'sonner'
import { useSessionRenewal } from '@/hooks/use-session-renewal'
import { NotificationPopup } from '@/components/features/notification-popup'

const LoginPage = lazy(() => import('@/pages/login').then(module => ({ default: module.LoginPage })))
const RegisterPage = lazy(() => import('@/pages/register').then(module => ({ default: module.RegisterPage })))
const RoomsPage = lazy(() => import('@/pages/rooms').then(module => ({ default: module.RoomsPage })))
const EditorPage = lazy(() => import('@/pages/editor').then(module => ({ default: module.EditorPage })))
const AdminPage = lazy(() => import('@/pages/admin').then(module => ({ default: module.AdminPage })))
const PlaybackPage = lazy(() => import('@/pages/playback').then(module => ({ default: module.PlaybackPage })))
const SettingsPage = lazy(() => import('@/pages/settings').then(module => ({ default: module.SettingsPage })))
const SharePage = lazy(() => import('@/pages/share').then(module => ({ default: module.SharePage })))
const JoinPage = lazy(() => import('@/pages/join').then(module => ({ default: module.JoinPage })))
const NotificationsPage = lazy(() => import('@/pages/notifications').then(module => ({ default: module.NotificationsPage })))
const AuditPage = lazy(() => import('@/pages/audit').then(module => ({ default: module.AuditPage })))

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((state) => state.user)
  const isLoading = useAuthStore((state) => state.isLoading)
  const isInitialized = useAuthStore((state) => state.isInitialized)

  if (!isInitialized || isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Spinner size="lg" />
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" replace />
  }

  return <>{children}</>
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((state) => state.user)
  const isLoading = useAuthStore((state) => state.isLoading)
  const isInitialized = useAuthStore((state) => state.isInitialized)

  if (!isInitialized || isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Spinner size="lg" />
      </div>
    )
  }

  if (user) {
    return <Navigate to="/rooms" replace />
  }

  return <>{children}</>
}

// RoomRoute allows authenticated users and guests (actorType !== null)
function RoomRoute({ children }: { children: React.ReactNode }) {
  const actorType = useAuthStore((state) => state.actorType)
  const isLoading = useAuthStore((state) => state.isLoading)
  const isInitialized = useAuthStore((state) => state.isInitialized)

  if (!isInitialized || isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Spinner size="lg" />
      </div>
    )
  }

  if (actorType === null) {
    return <Navigate to="/login" replace />
  }

  return <>{children}</>
}

function RoomEditor() {
  const { roomId } = useParams()
  const sessionId = useAuthStore((state) => state.sessionId)
  // Identity changes must tear down editor bindings and pending requests.
  return <EditorPage key={`${roomId}:${sessionId}`} />
}

function ShareRoute() {
  const { shareToken } = useParams()
  return <SharePage key={shareToken} />
}

function AppRoutes() {
  return (
    <Routes>
      {/* Public routes */}
      <Route
        path="/login"
        element={
          <PublicRoute>
            <LoginPage />
          </PublicRoute>
        }
      />
      <Route
        path="/register"
        element={
          <PublicRoute>
            <RegisterPage />
          </PublicRoute>
        }
      />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/s/:shareToken" element={<ShareRoute />} />
      <Route path="/join" element={<JoinPage />} />

      <Route path="/admin/audit" element={<PrivateRoute><Suspense fallback={<Spinner />}><AuditPage /></Suspense></PrivateRoute>} />

      {/* Protected routes */}
      <Route
        path="/rooms"
        element={
          <PrivateRoute>
            <RoomsPage />
          </PrivateRoute>
        }
      />
      <Route
        path="/room/:roomId"
        element={
          <RoomRoute>
            <RoomEditor />
          </RoomRoute>
        }
      />
      <Route
        path="/admin"
        element={
          <PrivateRoute>
            <AdminPage />
          </PrivateRoute>
        }
      />
      <Route
        path="/notifications"
        element={
          <PrivateRoute>
            <NotificationsPage />
          </PrivateRoute>
        }
      />
      <Route
        path="/playback/:roomId"
        element={
          <PrivateRoute>
            <PlaybackPage />
          </PrivateRoute>
        }
      />

      {/* Redirect root to rooms or login */}
      <Route path="/" element={<Navigate to="/rooms" replace />} />

      {/* Catch-all redirect */}
      <Route path="*" element={<Navigate to="/rooms" replace />} />
    </Routes>
  )
}

function AppContent() {
  useSessionRenewal()
  const initialize = useAuthStore((state) => state.initialize)
  const theme = useThemeStore((state) => state.theme)

  useEffect(() => {
    initialize()
  }, [initialize])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // Apply stealth settings on startup for Tauri app
  useEffect(() => {
    if (!isTauriApp()) return

    const initStealth = async () => {
      try {
        const settings = getStealthSettings()
        await applyStealthSettings(settings)
      } catch (error) {
        console.error('Failed to apply stealth settings:', error)
      }
    }

    initStealth()
  }, [])

  const Router = isTauriApp() ? HashRouter : BrowserRouter

  return (
    <Router>
      <TooltipProvider>
        <Suspense fallback={<div className="flex min-h-dvh items-center justify-center"><Spinner /></div>}><AppRoutes /></Suspense>
        <NotificationPopup />
        <Toaster />
      </TooltipProvider>
    </Router>
  )
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppContent />
    </QueryClientProvider>
  )
}

export default App
