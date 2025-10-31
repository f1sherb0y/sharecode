import type { Request, Response } from 'express'
import { prisma } from '../utils/db'

export async function getAllUsers(req: Request, res: Response) {
    try {
        const users = await prisma.user.findMany({
            where: {
                isDeleted: false,
            },
            select: {
                id: true,
                email: true,
                username: true,
                color: true,
                role: true,
                createdAt: true,
                lastSeen: true,
            },
            orderBy: {
                createdAt: 'desc',
            },
        })

        res.json({ users })
    } catch (error) {
        console.error('Get all users error:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
}

export async function deleteUser(req: Request, res: Response) {
    try {
        const { id } = req.params

        // Soft delete user
        await prisma.user.update({
            where: { id },
            data: { isDeleted: true },
        })

        res.json({ message: 'User deleted successfully' })
    } catch (error) {
        console.error('Delete user error:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
}

export async function getAllRooms(req: Request, res: Response) {
    try {
        const rooms = await prisma.room.findMany({
            where: {
                isDeleted: false,
            },
            include: {
                owner: {
                    select: {
                        id: true,
                        username: true,
                        email: true,
                    },
                },
                participants: {
                    include: {
                        user: {
                            select: {
                                id: true,
                                username: true,
                            },
                        },
                    },
                },
            },
            orderBy: {
                createdAt: 'desc',
            },
        })

        res.json({ rooms })
    } catch (error) {
        console.error('Get all rooms error:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
}

export async function deleteRoom(req: Request, res: Response) {
    try {
        const { id } = req.params

        // Soft delete room
        await prisma.room.update({
            where: { id },
            data: { isDeleted: true },
        })

        res.json({ message: 'Room deleted successfully' })
    } catch (error) {
        console.error('Delete room error:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
}
