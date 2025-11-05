import type { Request, Response } from 'express'
import bcrypt from 'bcrypt'
import { prisma } from '../utils/db'
import { generateUserToken } from '../utils/jwt'
import { getRandomUserColor } from '../utils/colors'

export async function register(req: Request, res: Response) {
    try {
        // Check if registration is enabled
        if (process.env.ALLOW_REGISTRATION === 'false') {
            return res.status(403).json({ error: 'Registration is currently disabled' })
        }

        const { email, username, password } = req.body

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' })
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
                color: getRandomUserColor(),
            },
        })

        // Generate token
        const token = generateUserToken({
            userId: user.id,
            email: user.email,
            username: user.username,
            role: user.role,
            canReadAllRooms: user.canReadAllRooms,
            canWriteAllRooms: user.canWriteAllRooms,
            canDeleteAllRooms: user.canDeleteAllRooms,
        })

        res.status(201).json({
            user: {
                id: user.id,
                email: user.email,
                username: user.username,
                color: user.color,
                role: user.role,
                canReadAllRooms: user.canReadAllRooms,
                canWriteAllRooms: user.canWriteAllRooms,
                canDeleteAllRooms: user.canDeleteAllRooms,
            },
            token,
        })
    } catch (error) {
        console.error('Register error:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
}

export async function login(req: Request, res: Response) {
    try {
        const { username, password } = req.body

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' })
        }

        // Find user by username
        const user = await prisma.user.findUnique({
            where: { username },
        })

        if (!user || user.isDeleted) {
            return res.status(401).json({ error: 'Invalid credentials' })
        }

        // Verify password
        const validPassword = await bcrypt.compare(password, user.password)

        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' })
        }

        // Generate token
        const token = generateUserToken({
            userId: user.id,
            email: user.email,
            username: user.username,
            role: user.role,
            canReadAllRooms: user.canReadAllRooms,
            canWriteAllRooms: user.canWriteAllRooms,
            canDeleteAllRooms: user.canDeleteAllRooms,
        })

        res.json({
            user: {
                id: user.id,
                email: user.email,
                username: user.username,
                color: user.color,
                role: user.role,
                canReadAllRooms: user.canReadAllRooms,
                canWriteAllRooms: user.canWriteAllRooms,
                canDeleteAllRooms: user.canDeleteAllRooms,
            },
            token,
        })
    } catch (error) {
        console.error('Login error:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
}

export async function getProfile(req: Request, res: Response) {
    try {
        const userId = (req as any).userId

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                email: true,
                username: true,
                color: true,
                role: true,
                canReadAllRooms: true,
                canWriteAllRooms: true,
                canDeleteAllRooms: true,
                createdAt: true,
            },
        })

        if (!user) {
            return res.status(404).json({ error: 'User not found' })
        }

        res.json({ user })
    } catch (error) {
        console.error('Get profile error:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
}

export async function getRegistrationStatus(req: Request, res: Response) {
    try {
        const allowRegistration = process.env.ALLOW_REGISTRATION !== 'false'
        res.json({ allowRegistration })
    } catch (error) {
        console.error('Get registration status error:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
}
