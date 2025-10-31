import type { Request, Response } from 'express'
import { prisma } from '../utils/db'
import { randomBytes } from 'crypto'

const SUPPORTED_LANGUAGES = [
    'javascript',
    'typescript',
    'python',
    'java',
    'cpp',
    'rust',
    'go',
    'php',
]

function generateDocumentId(): string {
    return `doc-${randomBytes(16).toString('hex')}`
}

export async function createRoom(req: Request, res: Response) {
    try {
        const userId = (req as any).userId
        const { name, language = 'javascript', scheduledTime, duration } = req.body

        if (!name) {
            return res.status(400).json({ error: 'Room name is required' })
        }

        if (!SUPPORTED_LANGUAGES.includes(language)) {
            return res.status(400).json({ error: 'Unsupported language' })
        }

        const documentId = generateDocumentId()

        const roomData: any = {
            name,
            language,
            documentId,
            ownerId: userId,
        }

        if (scheduledTime) {
            roomData.scheduledTime = new Date(scheduledTime)
        }
        if (duration) {
            roomData.duration = parseInt(duration)
        }

        const room = await prisma.room.create({
            data: roomData,
            include: {
                owner: {
                    select: {
                        id: true,
                        username: true,
                        color: true,
                    },
                },
            },
        })

        res.status(201).json({ room })
    } catch (error) {
        console.error('Create room error:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
}

export async function getRooms(req: Request, res: Response) {
    try {
        const userId = (req as any).userId

        // Get all non-deleted rooms - users can see and join any room
        const rooms = await prisma.room.findMany({
            where: {
                isDeleted: false,
            },
            include: {
                owner: {
                    select: {
                        id: true,
                        username: true,
                        color: true,
                    },
                },
                participants: {
                    include: {
                        user: {
                            select: {
                                id: true,
                                username: true,
                                color: true,
                            },
                        },
                    },
                },
            },
            orderBy: {
                updatedAt: 'desc',
            },
        })

        // Mark which rooms the user is part of and check expiration
        const now = new Date()
        const roomsWithMembership = rooms.map(room => {
            let isExpired = false
            if (room.scheduledTime && room.duration) {
                const endTime = new Date(room.scheduledTime.getTime() + room.duration * 60000)
                isExpired = endTime < now
            }

            return {
                ...room,
                isMember: room.ownerId === userId || room.participants.some(p => p.userId === userId),
                isOwner: room.ownerId === userId,
                isExpired,
            }
        })

        res.json({ rooms: roomsWithMembership })
    } catch (error) {
        console.error('Get rooms error:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
}

export async function getRoom(req: Request, res: Response) {
    try {
        const userId = (req as any).userId
        const { roomId } = req.params

        // Allow any authenticated user to view any room
        const room = await prisma.room.findUnique({
            where: { id: roomId },
            include: {
                owner: {
                    select: {
                        id: true,
                        username: true,
                        color: true,
                    },
                },
                participants: {
                    include: {
                        user: {
                            select: {
                                id: true,
                                username: true,
                                color: true,
                            },
                        },
                    },
                },
            },
        })

        if (!room) {
            return res.status(404).json({ error: 'Room not found' })
        }

        res.json({ room })
    } catch (error) {
        console.error('Get room error:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
}

export async function updateRoom(req: Request, res: Response) {
    try {
        const userId = (req as any).userId
        const { roomId } = req.params
        const { name, language } = req.body

        // Check if user is owner
        const room = await prisma.room.findFirst({
            where: {
                id: roomId,
                ownerId: userId,
            },
        })

        if (!room) {
            return res.status(403).json({ error: 'Not authorized' })
        }

        const updateData: any = {}
        if (name) updateData.name = name
        if (language && SUPPORTED_LANGUAGES.includes(language)) {
            updateData.language = language
        }

        const updatedRoom = await prisma.room.update({
            where: { id: roomId },
            data: updateData,
            include: {
                owner: {
                    select: {
                        id: true,
                        username: true,
                        color: true,
                    },
                },
            },
        })

        res.json({ room: updatedRoom })
    } catch (error) {
        console.error('Update room error:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
}

export async function deleteRoom(req: Request, res: Response) {
    try {
        const userId = (req as any).userId
        const { roomId } = req.params

        // Check if user is owner
        const room = await prisma.room.findFirst({
            where: {
                id: roomId,
                ownerId: userId,
            },
        })

        if (!room) {
            return res.status(403).json({ error: 'Not authorized' })
        }

        await prisma.room.delete({
            where: { id: roomId },
        })

        res.json({ message: 'Room deleted' })
    } catch (error) {
        console.error('Delete room error:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
}

export async function joinRoom(req: Request, res: Response) {
    try {
        const userId = (req as any).userId
        const { roomId } = req.params

        if (!roomId) {
            return res.status(400).json({ error: 'Room ID is required' })
        }

        // Check if room exists
        const room = await prisma.room.findUnique({
            where: { id: roomId },
        })

        if (!room) {
            return res.status(404).json({ error: 'Room not found' })
        }

        // Check if already a participant
        const existing = await prisma.roomParticipant.findUnique({
            where: {
                roomId_userId: {
                    roomId,
                    userId,
                },
            },
        })

        if (existing) {
            return res.status(400).json({ error: 'Already a participant' })
        }

        // Add participant
        await prisma.roomParticipant.create({
            data: {
                roomId,
                userId,
            },
        })

        res.json({ message: 'Joined room successfully' })
    } catch (error) {
        console.error('Join room error:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
}

export async function leaveRoom(req: Request, res: Response) {
    try {
        const userId = (req as any).userId
        const { roomId } = req.params

        // Can't leave if you're the owner
        const room = await prisma.room.findFirst({
            where: {
                id: roomId,
                ownerId: userId,
            },
        })

        if (room) {
            return res.status(400).json({ error: 'Owner cannot leave room' })
        }

        // Remove participant
        await prisma.roomParticipant.deleteMany({
            where: {
                roomId,
                userId,
            },
        })

        res.json({ message: 'Left room successfully' })
    } catch (error) {
        console.error('Leave room error:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
}

export async function endRoom(req: Request, res: Response) {
    try {
        const userId = (req as any).userId
        const { roomId } = req.params

        // Check if user is owner
        const room = await prisma.room.findFirst({
            where: {
                id: roomId,
                ownerId: userId,
            },
        })

        if (!room) {
            return res.status(403).json({ error: 'Not authorized' })
        }

        // End the room
        const updatedRoom = await prisma.room.update({
            where: { id: roomId },
            data: {
                isEnded: true,
                endedAt: new Date(),
            },
        })

        res.json({ room: updatedRoom })
    } catch (error) {
        console.error('End room error:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
}
