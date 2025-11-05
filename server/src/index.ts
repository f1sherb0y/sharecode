import express, { type Request, type Response } from 'express'
import { createServer } from 'http'
import cors from 'cors'
import { startHocuspocusServer } from './hocuspocus/server'
import { initializeAdmin } from './utils/initAdmin'
import { logger } from './utils/logger'
import { requestLogger } from './middleware/requestLogger'
import { register, login, getProfile, getRegistrationStatus } from './api/auth'
import {
    createRoom,
    getRooms,
    getRoom,
    updateRoom,
    deleteRoom,
    joinRoom,
    leaveRoom,
    endRoom,
    getAllUsersForRoomCreation,
} from './api/rooms'
import { authMiddleware } from './middleware/auth'
import { adminMiddleware } from './middleware/admin'
import {
    getAllUsers,
    deleteUser,
    getAllRooms as adminGetAllRooms,
    deleteRoom as adminDeleteRoom,
    createUser,
    updateUser,
} from './api/admin'
import { getPlaybackUpdates } from './api/playback'
import {
    createShareLink,
    listShareLinks,
    deleteShareLink,
    getShareInfo,
    joinShareLink,
    getGuestSession,
} from './api/share'

const app = express()
const PORT = parseInt(process.env.PORT || '3001')

// Middleware
const allowedOrigins = [
    'http://localhost:5173',
    'http://localhost:3000',
    'http://localhost:4173',
    process.env.FRONTEND_URL,
].filter(Boolean) as string[]

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin) {
            callback(null, true)
            return
        }

        // Check if origin is in allowed list
        if (allowedOrigins.includes(origin)) {
            callback(null, true)
            return
        }

        // For production with reverse proxy, also check if origin matches domain
        const domain = process.env.DOMAIN
        if (domain && (origin === `https://${domain}` || origin === `http://${domain}`)) {
            callback(null, true)
            return
        }

        logger.warn(`CORS blocked origin: ${origin}`)
        logger.warn(`Allowed origins: ${allowedOrigins.join(', ')}`)
        if (domain) logger.warn(`Domain: ${domain}`)
        callback(new Error('Not allowed by CORS'))
    },
    credentials: true,
}))
app.use(express.json())
app.use(requestLogger)

// Health check
app.get('/health', (req: Request, res: Response) => {
    res.json({ status: 'ok' })
})

// Auth routes
app.post('/api/auth/register', register)
app.post('/api/auth/login', login)
app.get('/api/auth/profile', authMiddleware, getProfile)
app.get('/api/config/registration', getRegistrationStatus)

// Room routes
app.get('/api/users', authMiddleware, getAllUsersForRoomCreation)
app.post('/api/rooms', authMiddleware, createRoom)
app.get('/api/rooms', authMiddleware, getRooms)
app.get('/api/rooms/:roomId', authMiddleware, getRoom)
app.put('/api/rooms/:roomId', authMiddleware, updateRoom)
app.delete('/api/rooms/:roomId', authMiddleware, deleteRoom)
app.post('/api/rooms/:roomId/join', authMiddleware, joinRoom)
app.post('/api/rooms/:roomId/leave', authMiddleware, leaveRoom)
app.post('/api/rooms/:roomId/end', authMiddleware, endRoom)
app.post('/api/rooms/:roomId/share-links', authMiddleware, createShareLink)
app.get('/api/rooms/:roomId/share-links', authMiddleware, listShareLinks)
app.delete('/api/rooms/:roomId/share-links/:shareLinkId', authMiddleware, deleteShareLink)

// Admin routes
app.post('/api/admin/users', authMiddleware, adminMiddleware, createUser)
app.get('/api/admin/users', authMiddleware, adminMiddleware, getAllUsers)
app.patch('/api/admin/users/:id', authMiddleware, adminMiddleware, updateUser)
app.delete('/api/admin/users/:id', authMiddleware, adminMiddleware, deleteUser)
app.get('/api/admin/rooms', authMiddleware, adminMiddleware, adminGetAllRooms)
app.delete('/api/admin/rooms/:id', authMiddleware, adminMiddleware, adminDeleteRoom)

// Playback routes
app.get('/api/rooms/:roomId/playback/updates', authMiddleware, getPlaybackUpdates)

// Share routes (specific routes before parameterized routes)
app.get('/api/share/session', getGuestSession)
app.get('/api/share/:token', getShareInfo)
app.post('/api/share/:token/join', joinShareLink)

// Create HTTP server and integrate Hocuspocus
const httpServer = createServer(app)
startHocuspocusServer(httpServer)

// Initialize admin user and start unified server
async function startServer() {
    await initializeAdmin()

    httpServer.listen(PORT, () => {
        logger.heading('Unified server (REST + WebSocket) running on port ' + PORT)
        logger.info(`   REST API: http://localhost:${PORT}`)
        logger.info(`   WebSocket: ws://localhost:${PORT}/ws`)
        logger.info(`   Log Level: ${process.env.LOG_LEVEL || 'info'}`)
    })
}

startServer()
