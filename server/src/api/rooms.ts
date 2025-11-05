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

interface AuthUser {
    id: string
    role: string
    canReadAllRooms: boolean
    canWriteAllRooms: boolean
    canDeleteAllRooms: boolean
}

function getAuthUser(req: Request): AuthUser {
    return (req as any).authUser as AuthUser
}

function hasGlobalRead(user: AuthUser): boolean {
    return user.canReadAllRooms || user.canWriteAllRooms || user.canDeleteAllRooms
}

function hasGlobalWrite(user: AuthUser): boolean {
    return user.canWriteAllRooms || user.canDeleteAllRooms
}

function hasGlobalDelete(user: AuthUser): boolean {
    return user.canDeleteAllRooms
}

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
        const authUser = getAuthUser(req)
        const userId = authUser.id

        // Build query based on user role
        let whereClause: any = {
            isDeleted: false,
        }

        // Users without global read access only see rooms they own or participate in
        if (!hasGlobalRead(authUser)) {
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
            const canEdit = room.ownerId === userId || hasGlobalWrite(authUser) || (userParticipant?.canEdit ?? false)

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
        const authUser = getAuthUser(req)
        const userId = authUser.id
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

        const isOwner = room.ownerId === userId
        const isParticipant = room.participants.some(p => p.userId === userId)

        if (!hasGlobalRead(authUser) && !isOwner && !isParticipant) {
            return res.status(403).json({ error: 'Access denied' })
        }

        res.json({ room })
    } catch (error) {
        console.error('Get room error:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
}

export async function updateRoom(req: Request, res: Response) {
    try {
        const authUser = getAuthUser(req)
        const userId = authUser.id
        const { roomId } = req.params
        const { name, language } = req.body

        const room = await prisma.room.findUnique({
            where: { id: roomId },
            include: {
                participants: true,
            },
        })

        if (!room) {
            return res.status(404).json({ error: 'Room not found' })
        }

        // Check permissions: global writers, owner, or participant with edit rights
        const isOwner = room.ownerId === userId
        const participant = room.participants.find(p => p.userId === userId)
        const canEdit = hasGlobalWrite(authUser) || isOwner || (participant?.canEdit ?? false)

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
        const authUser = getAuthUser(req)
        const userId = authUser.id
        const { roomId } = req.params

        const room = await prisma.room.findUnique({
            where: { id: roomId },
        })

        if (!room) {
            return res.status(404).json({ error: 'Room not found' })
        }

        // Only owner or users with delete-all permission can delete
        if (room.ownerId !== userId && !hasGlobalDelete(authUser)) {
            return res.status(403).json({ error: 'Not authorized to delete this room' })
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
        const authUser = getAuthUser(req)
        const userId = authUser.id
        const { roomId } = req.params

        const room = await prisma.room.findUnique({
            where: { id: roomId },
        })

        if (!room) {
            return res.status(404).json({ error: 'Room not found' })
        }

        if (room.ownerId !== userId && !hasGlobalDelete(authUser)) {
            return res.status(403).json({ error: 'Not authorized to end this room' })
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
