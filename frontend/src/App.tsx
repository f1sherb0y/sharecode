import { useEffect } from 'react'
import { BrowserRouter, HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui'
import {
  LoginPage,
  RegisterPage,
  RoomsPage,
  EditorPage,
  AdminPage,
  PlaybackPage,
  SettingsPage,
  SharePage,
} from '@/pages'
import { useAuthStore, useThemeStore } from '@/stores'
import {
  isTauriApp,
  getStealthSettings,
  applyStealthSettings,
} from '@/lib/tauri'
import { Spinner } from '@/components/ui'
import { Toaster } from 'sonner'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60,
      retry: 1,
    },
  },
})

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading, isInitialized } = useAuthStore()

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
  const { user, isLoading, isInitialized } = useAuthStore()

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
  const { actorType, isLoading, isInitialized } = useAuthStore()

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
      <Route path="/s/:shareToken" element={<SharePage />} />

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
            <EditorPage />
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
  const { initialize } = useAuthStore()
  const { theme } = useThemeStore()

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
        <AppRoutes />
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
