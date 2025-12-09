import { useEffect } from 'react'
import { BrowserRouter, HashRouter, Routes, Route, Navigate, useSearchParams } from 'react-router-dom'
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
} from '@/pages'
import { useAuthStore, useThemeStore } from '@/stores'
import { isTauriApp } from '@/lib/tauri'
import { Spinner } from '@/components/ui'

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

// RoomRoute allows both authenticated users and guests with share tokens
function RoomRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading, isInitialized } = useAuthStore()
  const [searchParams] = useSearchParams()
  const shareToken = searchParams.get('share')

  if (!isInitialized || isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Spinner size="lg" />
      </div>
    )
  }

  // Allow access if user is authenticated OR has a share token
  if (!user && !shareToken) {
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

  const Router = isTauriApp() ? HashRouter : BrowserRouter

  return (
    <Router>
      <TooltipProvider>
        <AppRoutes />
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
