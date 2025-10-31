import { Server } from '@hocuspocus/server'
import type { Server as HttpServer, IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import type { WebSocket } from 'ws'
import { databaseExtension } from './extensions/database'
import { prisma } from '../utils/db'
import { verifyToken } from '../utils/jwt'

export const hocuspocusServer = new Server({
    extensions: [databaseExtension],

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

            // Find room by documentId - any authenticated user can join
            const room = await prisma.room.findFirst({
                where: { documentId: documentName },
                include: { owner: true },
            })

            if (!room) {
                throw new Error(`Room with document ${documentName} not found`)
            }

            // Auto-add user as participant if they're not already
            if (room.ownerId !== user.id) {
                const existingParticipant = await prisma.roomParticipant.findUnique({
                    where: {
                        roomId_userId: {
                            roomId: room.id,
                            userId: user.id,
                        },
                    },
                })

                if (!existingParticipant) {
                    await prisma.roomParticipant.create({
                        data: {
                            roomId: room.id,
                            userId: user.id,
                        },
                    })
                    console.log(`✨ Auto-added ${user.username} as participant to ${room.name}`)
                }
            }

            // TODO: Implement read-only mode when Hocuspocus API supports it
            // if (room.ownerId !== user.id && !room.allowEdit) {
            //     data.connection.readOnly = true
            // }

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
                },
                room: {
                    id: room.id,
                    name: room.name,
                    language: room.language,
                },
            }
        } catch (error) {
            console.error('Authentication error:', error)
            throw new Error('Authentication failed: ' + (error as Error).message)
        }
    },

    async onConnect(data) {
        const { context, documentName } = data
        if (context?.user) {
            console.log(`✅ ${context.user.username} connected to ${documentName}`)
        }
    },

    async onDisconnect(data) {
        const { context, documentName } = data
        if (context?.user) {
            console.log(`❌ ${context.user.username} disconnected from ${documentName}`)
        }
    },

    async onDestroy(data) {
        console.log(`🗑️  Document destroyed (no active connections)`)
    },

    async onChange(data) {
        const { documentName, context } = data
        if (context?.user) {
            console.log(`📝 Document ${documentName} changed by ${context.user.username}`)
        }
    },
})

export function startHocuspocusServer(httpServer: HttpServer) {
    const rawPath = process.env.WS_PATH || '/ws'
    const normalizedPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`

    const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        const { url } = request
        if (!url) return

        let pathname = ''
        try {
            const host = request.headers.host || 'localhost'
            pathname = new URL(url, `http://${host}`).pathname
        } catch (error) {
            console.error('Invalid WebSocket request URL:', url, error)
            socket.destroy()
            return
        }

        if (pathname !== normalizedPath) {
            return
        }

        hocuspocusServer.webSocketServer.handleUpgrade(request, socket, head, (ws: WebSocket) => {
            hocuspocusServer.webSocketServer.emit('connection', ws, request)
        })
    }

    httpServer.on('upgrade', handleUpgrade)

    console.log(`🚀 Hocuspocus WebSocket server attached at path ${normalizedPath}`)
}
