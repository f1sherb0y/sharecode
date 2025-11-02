import type { Request, Response } from 'express'
import bcrypt from 'bcrypt'
import { prisma } from '../utils/db'

const USER_COLORS = [
    '#30bced',
    '#6eeb83',
    '#ffbc42',
    '#ecd444',
    '#ee6352',
    '#9ac2c9',
    '#8acb88',
    '#1be7ff',
]

function getRandomColor() {
    return USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)]
}

export async function createUser(req: Request, res: Response) {
    try {
        const { username, password, email, role = 'user' } = req.body

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' })
        }

        // Validate role
        if (!['user', 'admin', 'observer'].includes(role)) {
            return res.status(400).json({ error: 'Invalid role' })
        }

        // Check if username already exists
        const existingUser = await prisma.user.findUnique({
            where: { username },
        })

        if (existingUser) {
            return res.status(400).json({ error: 'Username already taken' })
        }

        // Check if email already exists (if provided)
        if (email) {
            const existingEmail = await prisma.user.findUnique({
                where: { email },
            })

            if (existingEmail) {
                return res.status(400).json({ error: 'Email already in use' })
            }
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10)

        // Create user
        const user = await prisma.user.create({
            data: {
                email,
                username,
                password: hashedPassword,
                color: getRandomColor(),
                role,
            },
        })

        res.status(201).json({
            user: {
                id: user.id,
                email: user.email,
                username: user.username,
                color: user.color,
                role: user.role,
            },
        })
    } catch (error) {
        console.error('Create user error:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
}

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
        const currentUserId = (req as any).userId
        const { id } = req.params

        // Check if user exists
        const user = await prisma.user.findUnique({
            where: { id },
        })

        if (!user) {
            return res.status(404).json({ error: 'User not found' })
        }

        if (user.isDeleted) {
            return res.status(400).json({ error: 'User is already deleted' })
        }

        // Prevent deleting yourself
        if (id === currentUserId) {
            return res.status(403).json({ error: 'Cannot delete your own account' })
        }

        // Prevent deleting admin users to ensure at least one admin remains
        if (user.role === 'admin') {
            const adminCount = await prisma.user.count({
                where: {
                    role: 'admin',
                    isDeleted: false,
                },
            })

            if (adminCount <= 1) {
                return res.status(403).json({ error: 'Cannot delete the last admin user' })
            }
        }

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
