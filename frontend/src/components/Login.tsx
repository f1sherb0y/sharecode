import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useNavigate } from 'react-router-dom'
import { ThemeToggle } from './ThemeToggle'

export function Login() {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [error, setError] = useState('')
    const [isLoading, setIsLoading] = useState(false)
    const { login } = useAuth()
    const navigate = useNavigate()

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setError('')
        setIsLoading(true)

        try {
            await login(email, password)
            navigate('/rooms')
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Login failed')
        } finally {
            setIsLoading(false)
        }
    }

    return (
        <div className="auth-container">
            <div className="auth-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
                    <h2>Login</h2>
                    <ThemeToggle />
                </div>
                <form className="auth-form" onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label className="form-label">Email</label>
                        <input
                            type="email"
                            placeholder="Enter your email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            required
                        />
                    </div>
                    <div className="form-group">
                        <label className="form-label">Password</label>
                        <input
                            type="password"
                            placeholder="Enter your password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                        />
                    </div>
                    {error && <div className="error-message">{error}</div>}
                    <button type="submit" disabled={isLoading}>
                        {isLoading ? 'Logging in...' : 'Login'}
                    </button>
                </form>
                <p style={{ textAlign: 'center', marginTop: '1rem', color: 'var(--text-secondary)' }}>
                    Don't have an account?{' '}
                    <a href="/register" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                        Register
                    </a>
                </p>
            </div>
        </div>
    )
}
