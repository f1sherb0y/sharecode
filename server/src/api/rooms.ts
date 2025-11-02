import type { Request, Response } from 'express'
import { prisma } from '../utils/db'
import { randomBytes } from 'crypto'

export async function getAllUsersForRoomCreation(req: Request, res: Response) {
    try {
        const users = await prisma.user.findMany({
            where: {
                isDeleted: false,
            },
            select: {
                id: true,
                username: true,
                color: true,
                role: true,
            },
            orderBy: {
                username: 'asc',
            },
        })

        res.json({ users })
    } catch (error) {
        console.error('Get users error:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
}

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
        const { name, language = 'javascript', scheduledTime, duration, allowedUsers = [] } = req.body

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

        // Create room with participants in a transaction
        const room = await prisma.$transaction(async (tx) => {
            const newRoom = await tx.room.create({
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

            // Auto-add owner as participant with edit permission
            await tx.roomParticipant.create({
                data: {
                    roomId: newRoom.id,
                    userId: userId,
                    canEdit: true,
                },
            })

            // Add allowed users as participants
            if (allowedUsers.length > 0) {
                await tx.roomParticipant.createMany({
                    data: allowedUsers
                        .filter((u: any) => u.userId !== userId) // Skip owner, already added
                        .map((u: any) => ({
                            roomId: newRoom.id,
                            userId: u.userId,
                            canEdit: u.canEdit ?? true,
                        })),
                    skipDuplicates: true,
                })
            }

            return newRoom
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
        const userRole = (req as any).role

        // Build query based on user role
        let whereClause: any = {
            isDeleted: false,
        }

        // Regular users only see rooms they have access to
        if (userRole !== 'admin' && userRole !== 'observer') {
            whereClause.OR = [
                { ownerId: userId },
                {
                    participants: {
                        some: {
                            userId: userId,
                        },
                    },
                },
            ]
        }
        // Admin and observer can see all rooms (no additional filter needed)

        const rooms = await prisma.room.findMany({
            where: whereClause,
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

            // Find user's participant record to get canEdit permission
            const userParticipant = room.participants.find(p => p.userId === userId)
            const canEdit = room.ownerId === userId || (userParticipant?.canEdit ?? false)

            return {
                ...room,
                isMember: room.ownerId === userId || room.participants.some(p => p.userId === userId),
                isOwner: room.ownerId === userId,
                canEdit,
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
        const userRole = (req as any).role
        const { roomId } = req.params

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

        // Check access: admin and observer can view any room
        // Regular users can only view if they're owner or participant
        if (userRole !== 'admin' && userRole !== 'observer') {
            const isOwner = room.ownerId === userId
            const isParticipant = room.participants.some(p => p.userId === userId)

            if (!isOwner && !isParticipant) {
                return res.status(403).json({ error: 'Access denied' })
            }
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
        const userRole = (req as any).role
        const { roomId } = req.params
        const { name, language } = req.body

        // Observers cannot modify rooms
        if (userRole === 'observer') {
            return res.status(403).json({ error: 'Observers cannot modify rooms' })
        }

        const room = await prisma.room.findUnique({
            where: { id: roomId },
            include: {
                participants: true,
            },
        })

        if (!room) {
            return res.status(404).json({ error: 'Room not found' })
        }

        // Check permissions: admin, owner, or participant with canEdit
        const isOwner = room.ownerId === userId
        const participant = room.participants.find(p => p.userId === userId)
        const canEdit = userRole === 'admin' || isOwner || (participant?.canEdit ?? false)

        if (!canEdit) {
            return res.status(403).json({ error: 'Not authorized to modify this room' })
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
        const userRole = (req as any).role
        const { roomId } = req.params

        // Observers cannot delete rooms
        if (userRole === 'observer') {
            return res.status(403).json({ error: 'Observers cannot delete rooms' })
        }

        const room = await prisma.room.findUnique({
            where: { id: roomId },
        })

        if (!room) {
            return res.status(404).json({ error: 'Room not found' })
        }

        // Only admin or owner can delete
        if (userRole !== 'admin' && room.ownerId !== userId) {
            return res.status(403).json({ error: 'Only room owner or admin can delete rooms' })
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
        const userRole = (req as any).role
        const { roomId } = req.params

        // Observers cannot end rooms
        if (userRole === 'observer') {
            return res.status(403).json({ error: 'Observers cannot end rooms' })
        }

        const room = await prisma.room.findUnique({
            where: { id: roomId },
        })

        if (!room) {
            return res.status(404).json({ error: 'Room not found' })
        }

        // Only admin or owner can end room
        if (userRole !== 'admin' && room.ownerId !== userId) {
            return res.status(403).json({ error: 'Only room owner or admin can end rooms' })
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
