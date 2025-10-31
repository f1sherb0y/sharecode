import type { Request, Response } from 'express'
import bcrypt from 'bcrypt'
import { prisma } from '../utils/db'
import { generateToken } from '../utils/jwt'

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

export async function register(req: Request, res: Response) {
    try {
        const { email, username, password } = req.body

        if (!email || !username || !password) {
            return res.status(400).json({ error: 'Missing required fields' })
        }

        // Check if user already exists
        const existingUser = await prisma.user.findFirst({
            where: {
                OR: [{ email }, { username }],
            },
        })

        if (existingUser) {
            return res.status(400).json({ error: 'User already exists' })
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
            },
        })

        // Generate token
        const token = generateToken({
            userId: user.id,
            email: user.email,
            username: user.username,
            role: user.role,
        })

        res.status(201).json({
            user: {
                id: user.id,
                email: user.email,
                username: user.username,
                color: user.color,
                role: user.role,
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
        const { email, password } = req.body

        if (!email || !password) {
            return res.status(400).json({ error: 'Missing required fields' })
        }

        // Find user
        const user = await prisma.user.findUnique({
            where: { email },
        })

        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' })
        }

        // Verify password
        const validPassword = await bcrypt.compare(password, user.password)

        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' })
        }

        // Generate token
        const token = generateToken({
            userId: user.id,
            email: user.email,
            username: user.username,
            role: user.role,
        })

        res.json({
            user: {
                id: user.id,
                email: user.email,
                username: user.username,
                color: user.color,
                role: user.role,
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
