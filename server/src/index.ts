import express, { type Request, type Response } from 'express'
import cors from 'cors'
import { startHocuspocusServer } from './hocuspocus/server'
import { register, login, getProfile } from './api/auth'
import {
    createRoom,
    getRooms,
    getRoom,
    updateRoom,
    deleteRoom,
    joinRoom,
    leaveRoom,
} from './api/rooms'
import { authMiddleware } from './middleware/auth'

const app = express()
const PORT = parseInt(process.env.PORT || '3001')

// Middleware
app.use(cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
}))
app.use(express.json())

// Health check
app.get('/health', (req: Request, res: Response) => {
    res.json({ status: 'ok' })
})

// Auth routes
app.post('/api/auth/register', register)
app.post('/api/auth/login', login)
app.get('/api/auth/profile', authMiddleware, getProfile)

// Room routes
app.post('/api/rooms', authMiddleware, createRoom)
app.get('/api/rooms', authMiddleware, getRooms)
app.get('/api/rooms/:roomId', authMiddleware, getRoom)
app.put('/api/rooms/:roomId', authMiddleware, updateRoom)
app.delete('/api/rooms/:roomId', authMiddleware, deleteRoom)
app.post('/api/rooms/:roomId/join', authMiddleware, joinRoom)
app.post('/api/rooms/:roomId/leave', authMiddleware, leaveRoom)

// Start servers
app.listen(PORT, () => {
    console.log(`🚀 API server running on port ${PORT}`)
})

startHocuspocusServer()
