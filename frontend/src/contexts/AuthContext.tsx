import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'
import { api } from '../lib/api'
import type { User } from '../types'

interface AuthContextType {
    user: User | null
    token: string | null
    login: (email: string, password: string) => Promise<void>
    register: (email: string, username: string, password: string) => Promise<void>
    logout: () => void
    isLoading: boolean
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(null)
    const [token, setToken] = useState<string | null>(null)
    const [isLoading, setIsLoading] = useState(true)

    useEffect(() => {
        // Check for existing token on mount
        const storedToken = localStorage.getItem('token')
        if (storedToken) {
            setToken(storedToken)
            // Fetch user profile
            api.getProfile()
                .then(({ user }) => setUser(user))
                .catch(() => {
                    // Invalid token
                    localStorage.removeItem('token')
                    setToken(null)
                })
                .finally(() => setIsLoading(false))
        } else {
            setIsLoading(false)
        }
    }, [])

    const login = async (email: string, password: string) => {
        const { user, token } = await api.login(email, password)
        localStorage.setItem('token', token)
        setToken(token)
        setUser(user)
    }

    const register = async (email: string, username: string, password: string) => {
        const { user, token } = await api.register(email, username, password)
        localStorage.setItem('token', token)
        setToken(token)
        setUser(user)
    }

    const logout = () => {
        localStorage.removeItem('token')
        setToken(null)
        setUser(null)
    }

    return (
        <AuthContext.Provider value={{ user, token, login, register, logout, isLoading }}>
            {children}
        </AuthContext.Provider>
    )
}

export function useAuth() {
    const context = useContext(AuthContext)
    if (context === undefined) {
        throw new Error('useAuth must be used within an AuthProvider')
    }
    return context
}
