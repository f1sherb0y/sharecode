import { Server } from '@hocuspocus/server'
import type { Server as HttpServer, IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import type { WebSocket } from 'ws'
import { databaseExtension } from './extensions/database'
import { updatesExtension } from './extensions/updates'
import { prisma } from '../utils/db'
import { verifyToken } from '../utils/jwt'
import { logger } from '../utils/logger'

export const hocuspocusServer = new Server({
    extensions: [databaseExtension, updatesExtension],

    async onAuthenticate(data) {
        const { token, documentName } = data

        if (!token) {
            throw new Error('No authentication token provided')
        }

        try {
            // Verify JWT token
            const decoded = verifyToken(token as string)

            // Get user from database
            const user = await prisma.user.findUnique({
                where: { id: decoded.userId },
            })

            if (!user) {
                throw new Error('User not found')
            }

            // Find room by documentId with participants
            const room = await prisma.room.findFirst({
                where: { documentId: documentName },
                include: {
                    owner: true,
                    participants: true,
                },
            })

            if (!room) {
                throw new Error(`Room with document ${documentName} not found`)
            }

            // Check access: admin and observer can access any room
            // Regular users need to be owner or participant
            const isOwner = room.ownerId === user.id
            const participant = room.participants.find(p => p.userId === user.id)
            const hasAccess = user.role === 'admin' || user.role === 'observer' || isOwner || participant

            if (!hasAccess) {
                throw new Error('Access denied: You do not have permission to access this room')
            }

            // Auto-add user as participant if they're not already (and not owner)
            // This applies when accessing via direct link or rejoining
            if (!isOwner && !participant) {
                await prisma.roomParticipant.create({
                    data: {
                        roomId: room.id,
                        userId: user.id,
                        canEdit: true, // Default to edit permission when auto-added
                    },
                })
                logger.debug(`Auto-added ${user.username} as participant to ${room.name}`)
            }

            // Update last seen
            await prisma.user.update({
                where: { id: user.id },
                data: { lastSeen: new Date() },
            })

            // Return context for other hooks
            return {
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email,
                    color: user.color,
                    role: user.role,
                },
                room: {
                    id: room.id,
                    name: room.name,
                    language: room.language,
                },
            }
        } catch (error) {
            logger.error('Authentication error:', error)
            throw new Error('Authentication failed: ' + (error as Error).message)
        }
    },

    async onConnect(data) {
        const { context, documentName } = data
        if (context?.user) {
            logger.websocket(`${context.user.username} connected to ${documentName}`)
        }
    },

    async onDisconnect(data) {
        const { context, documentName } = data
        if (context?.user) {
            logger.websocket(`${context.user.username} disconnected from ${documentName}`)
        }
    },

    async onDestroy(data) {
        logger.debug(`Document destroyed (no active connections)`)
    },

    async onChange(data) {
        const { documentName, context } = data
        if (context?.user) {
            logger.debug(`Document ${documentName} changed by ${context.user.username}`)
        }
    },
})

export function startHocuspocusServer(httpServer: HttpServer) {
    const wsPath = '/api/ws'

    const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        const { url } = request
        if (!url) return

        let pathname = ''
        try {
            const host = request.headers.host || 'localhost'
            pathname = new URL(url, `http://${host}`).pathname
        } catch (error) {
            logger.error('Invalid WebSocket request URL:', url, error)
            socket.destroy()
            return
        }

        if (pathname !== wsPath) {
            return
        }

        hocuspocusServer.webSocketServer.handleUpgrade(request, socket, head, (ws: WebSocket) => {
            hocuspocusServer.webSocketServer.emit('connection', ws, request)
        })
    }

    httpServer.on('upgrade', handleUpgrade)

    logger.success(`Hocuspocus WebSocket server attached at path ${wsPath}`)
}
