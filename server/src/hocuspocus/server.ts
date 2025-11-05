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

            if (decoded.type === 'user') {
                // Get user from database
                const user = await prisma.user.findUnique({
                    where: { id: decoded.userId },
                })

                if (!user || user.isDeleted) {
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

                // Check access: users with global read/write/delete or room membership may connect
                const isOwner = room.ownerId === user.id
                const participant = room.participants.find(p => p.userId === user.id)
                const canReadGlobally = user.canReadAllRooms || user.canWriteAllRooms || user.canDeleteAllRooms
                const canWriteGlobally = user.canWriteAllRooms || user.canDeleteAllRooms
                const hasAccess = canReadGlobally || isOwner || participant

                if (!hasAccess) {
                    throw new Error('Access denied: You do not have permission to access this room')
                }

                const participantCanEdit = participant?.canEdit ?? false
                const canEdit = canWriteGlobally || isOwner || participantCanEdit

                const connection = (data as any).connection
                if (!canEdit && connection) {
                    connection.readOnly = true
                }

                // Auto-add user as participant if they're not already (and not owner)
                // This applies when accessing via direct link or rejoining
                if (!isOwner && !participant) {
                    await prisma.roomParticipant.create({
                        data: {
                            roomId: room.id,
                            userId: user.id,
                            canEdit: canWriteGlobally,
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
                    sessionType: 'user',
                    user: {
                        id: user.id,
                        username: user.username,
                        email: user.email,
                        color: user.color,
                        role: user.role,
                    },
                    permissions: {
                        canEdit,
                    },
                    room: {
                        id: room.id,
                        name: room.name,
                        language: room.language,
                    },
                }
            }

            if (decoded.type === 'guest') {
                const guest = await prisma.guestSession.findUnique({
                    where: { id: decoded.guestId },
                    include: {
                        room: {
                            include: {
                                owner: true,
                            },
                        },
                        shareLink: true,
                    },
                })

                if (!guest) {
                    throw new Error('Guest session not found')
                }

                if (guest.token !== decoded.sessionToken) {
                    throw new Error('Guest session token mismatch')
                }

                if (guest.room.documentId !== documentName) {
                    throw new Error('Guest session does not match this document')
                }

                if (guest.room.isDeleted || guest.room.isEnded) {
                    throw new Error('Room is no longer available')
                }

                const effectiveCanEdit = guest.canEdit && guest.room.allowEdit && guest.shareLink.canEdit

                const connection = (data as any).connection
                if (!effectiveCanEdit && connection) {
                    connection.readOnly = true
                }

                await prisma.guestSession.update({
                    where: { id: guest.id },
                    data: {
                        lastActive: new Date(),
                        canEdit: effectiveCanEdit,
                    },
                })

                return {
                    sessionType: 'guest',
                    guest: {
                        id: guest.id,
                        displayName: guest.displayName,
                        email: guest.email,
                        color: guest.color,
                    },
                    permissions: {
                        canEdit: effectiveCanEdit,
                    },
                    room: {
                        id: guest.room.id,
                        name: guest.room.name,
                        language: guest.room.language,
                    },
                }
            }

            throw new Error('Unsupported token type')
        } catch (error) {
            logger.error('Authentication error:', error)
            throw new Error('Authentication failed: ' + (error as Error).message)
        }
    },

    async onConnect(data) {
        const { context, documentName } = data
        if (context?.sessionType === 'user' && context.user) {
            logger.websocket(`${context.user.username} connected to ${documentName}`)
        }
        if (context?.sessionType === 'guest' && context.guest) {
            logger.websocket(`Guest ${context.guest.displayName} connected to ${documentName}`)
        }
    },

    async onDisconnect(data) {
        const { context, documentName } = data
        if (context?.sessionType === 'user' && context.user) {
            logger.websocket(`${context.user.username} disconnected from ${documentName}`)
        }
        if (context?.sessionType === 'guest' && context.guest) {
            logger.websocket(`Guest ${context.guest.displayName} disconnected from ${documentName}`)
        }
    },

    async onDestroy(data) {
        logger.debug(`Document destroyed (no active connections)`)
    },

    async onChange(data) {
        const { documentName, context } = data
        if (context?.sessionType === 'user' && context.user) {
            logger.debug(`Document ${documentName} changed by ${context.user.username}`)
        }
        if (context?.sessionType === 'guest' && context.guest) {
            logger.debug(`Document ${documentName} changed by guest ${context.guest.displayName}`)
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
