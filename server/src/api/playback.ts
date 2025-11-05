import type { Request, Response } from 'express'
import { promisify } from 'util'
import { gzip } from 'zlib'
import { prisma } from '../utils/db'

const gzipAsync = promisify(gzip)

interface AuthUser {
    id: string
    canReadAllRooms: boolean
    canWriteAllRooms: boolean
    canDeleteAllRooms: boolean
}

function hasGlobalRead(user: AuthUser): boolean {
    return user.canReadAllRooms || user.canWriteAllRooms || user.canDeleteAllRooms
}

export async function getPlaybackUpdates(req: Request, res: Response) {
    try {
        const authUser = (req as any).authUser as AuthUser | undefined
        if (!authUser) {
            return res.status(401).json({ error: 'Authentication required' })
        }

        const { roomId } = req.params

        // Get room
        const room = await prisma.room.findUnique({
            where: { id: roomId },
            include: {
                participants: {
                    select: { userId: true },
                },
            },
        })

        if (!room) {
            return res.status(404).json({ error: 'Room not found' })
        }

        if (!room.isEnded) {
            return res.status(400).json({ error: 'Room has not ended yet' })
        }

        const isOwner = room.ownerId === authUser.id
        const isParticipant = room.participants.some(p => p.userId === authUser.id)

        if (!hasGlobalRead(authUser) && !isOwner && !isParticipant) {
            return res.status(403).json({ error: 'Access denied' })
        }

        // Get all updates for this document
        const updates = await prisma.documentUpdate.findMany({
            where: {
                documentId: room.documentId,
            },
            orderBy: {
                timestamp: 'asc',
            },
            select: {
                id: true,
                timestamp: true,
                update: true,
                userId: true,
            },
        })

        if (updates.length === 0) {
            return res.json({
                updates: [],
                startTime: null,
                endTime: null,
                duration: 0,
            })
        }

        const startTime = updates[0]!.timestamp
        const endTime = updates[updates.length - 1]!.timestamp
        const duration = (endTime.getTime() - startTime.getTime()) / 1000 // seconds

        // Compress and convert updates to base64 for transport
        const updatesData = await Promise.all(
            updates.map(async (u) => {
                const compressed = await gzipAsync(u.update)
                return {
                    id: u.id,
                    timestamp: u.timestamp.toISOString(),
                    update: compressed.toString('base64'),
                    userId: u.userId,
                }
            })
        )

        res.json({
            updates: updatesData,
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            duration,
        })
    } catch (error) {
        console.error('Get playback updates error:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
}
