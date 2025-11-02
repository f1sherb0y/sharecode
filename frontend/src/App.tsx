import { HashRouter, BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { ThemeProvider } from './contexts/ThemeContext'
import { Login } from './components/Login'
import { Register } from './components/Register'
import { RoomList } from './components/RoomList'
import { Editor } from './components/Editor'
import { Admin } from './components/Admin'
import { RoomPlayback } from './components/RoomPlayback'
import { Settings } from './components/Settings'

// Detect if running in Tauri desktop environment
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
const Router = isTauri ? HashRouter : BrowserRouter

// Check if registration is allowed (build-time environment variable)
const ALLOW_REGISTRATION = import.meta.env.VITE_ALLOW_REGISTRATION !== 'false'

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth()

  if (isLoading) {
    return <div style={{ padding: '20px' }}>Loading...</div>
  }

  return user ? <>{children}</> : <Navigate to="/login" />
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth()

  if (isLoading) {
    return <div style={{ padding: '20px' }}>Loading...</div>
  }

  return user ? <Navigate to="/rooms" /> : <>{children}</>
}

function AppRoutes() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <PublicRoute>
            <Login />
          </PublicRoute>
        }
      />
      {ALLOW_REGISTRATION && (
        <Route
          path="/register"
          element={
            <PublicRoute>
              <Register />
            </PublicRoute>
          }
        />
      )}
      <Route
        path="/rooms"
        element={
          <PrivateRoute>
            <RoomList />
          </PrivateRoute>
        }
      />
      <Route
        path="/editor/:roomId"
        element={
          <PrivateRoute>
            <Editor />
          </PrivateRoute>
        }
      />
      <Route
        path="/admin"
        element={
          <PrivateRoute>
            <Admin />
          </PrivateRoute>
        }
      />
      <Route
        path="/playback/:roomId"
        element={
          <PrivateRoute>
            <RoomPlayback />
          </PrivateRoute>
        }
      />
      <Route
        path="/settings"
        element={<Settings />}
      />
      <Route path="/" element={<Navigate to="/rooms" />} />
    </Routes>
  )
}

function App() {
  return (
    <Router>
      <ThemeProvider>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </ThemeProvider>
    </Router>
  )
}

export default App
