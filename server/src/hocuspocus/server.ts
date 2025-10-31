import { Server } from '@hocuspocus/server'
import { databaseExtension } from './extensions/database'
import { prisma } from '../utils/db'
import { verifyToken } from '../utils/jwt'

const WS_PORT = parseInt(process.env.WS_PORT || '1234')

export const hocuspocusServer = new Server({
    port: WS_PORT,

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

            // Check if user has access to this document
            console.log('Looking for room with documentId:', documentName)
            console.log('User ID:', user.id)

            const room = await prisma.room.findFirst({
                where: {
                    documentId: documentName,
                    OR: [
                        { ownerId: user.id },
                        { participants: { some: { userId: user.id } } },
                    ],
                },
                include: {
                    owner: true,
                },
            })

            console.log('Found room:', room ? room.id : 'null')

            if (!room) {
                // Check if the room exists at all
                const anyRoom = await prisma.room.findUnique({
                    where: { documentId: documentName }
                })
                if (!anyRoom) {
                    throw new Error(`Document ${documentName} does not exist`)
                } else {
                    throw new Error(`User ${user.username} does not have access to document ${documentName}`)
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

export function startHocuspocusServer() {
    hocuspocusServer.listen()
    console.log(`🚀 Hocuspocus WebSocket server running on port ${WS_PORT}`)
}
