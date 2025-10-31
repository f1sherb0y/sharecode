import express, { type Request, type Response } from 'express'
import { createServer } from 'http'
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
    endRoom,
} from './api/rooms'
import { authMiddleware } from './middleware/auth'
import { adminMiddleware } from './middleware/admin'
import { getAllUsers, deleteUser, getAllRooms as adminGetAllRooms, deleteRoom as adminDeleteRoom } from './api/admin'
import { getPlaybackUpdates } from './api/playback'

const app = express()
const PORT = parseInt(process.env.PORT || '3001')

// Middleware
const allowedOrigins = [
    'http://localhost:5173',
    'http://localhost:3000',
    process.env.FRONTEND_URL,
].filter(Boolean)

app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true)
        } else {
            callback(new Error('Not allowed by CORS'))
        }
    },
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
app.post('/api/rooms/:roomId/end', authMiddleware, endRoom)

// Admin routes
app.get('/api/admin/users', adminMiddleware, getAllUsers)
app.delete('/api/admin/users/:id', adminMiddleware, deleteUser)
app.get('/api/admin/rooms', adminMiddleware, adminGetAllRooms)
app.delete('/api/admin/rooms/:id', adminMiddleware, adminDeleteRoom)

// Playback routes
app.get('/api/rooms/:roomId/playback/updates', authMiddleware, getPlaybackUpdates)

// Create HTTP server and integrate Hocuspocus
const httpServer = createServer(app)
startHocuspocusServer(httpServer)

// Start unified server
httpServer.listen(PORT, () => {
    console.log(`🚀 Unified server (REST + WebSocket) running on port ${PORT}`)
    console.log(`   REST API: http://localhost:${PORT}`)
    console.log(`   WebSocket: ws://localhost:${PORT}/ws`)
})
