import type { Request, Response, NextFunction } from 'express'
import { verifyToken } from '../utils/jwt'
import { prisma } from '../utils/db'

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
    try {
        const authHeader = req.headers.authorization

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'No token provided' })
        }

        const token = authHeader.substring(7)
        const decoded = verifyToken(token)

        if (decoded.type !== 'user') {
            return res.status(401).json({ error: 'Invalid token' })
        }

        const user = await prisma.user.findUnique({
            where: { id: decoded.userId },
            select: {
                id: true,
                username: true,
                email: true,
                role: true,
                isDeleted: true,
                canReadAllRooms: true,
                canWriteAllRooms: true,
                canDeleteAllRooms: true,
            },
        })

        if (!user || user.isDeleted) {
            return res.status(401).json({ error: 'Invalid token' })
        }

        const authUser = {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role,
            canReadAllRooms: user.canReadAllRooms,
            canWriteAllRooms: user.canWriteAllRooms,
            canDeleteAllRooms: user.canDeleteAllRooms,
        }

        // Attach authenticated user information to request
        ; (req as any).authUser = authUser
        ; (req as any).userId = user.id
        ; (req as any).username = user.username
        ; (req as any).role = user.role
        ; (req as any).permissions = {
            canReadAllRooms: user.canReadAllRooms,
            canWriteAllRooms: user.canWriteAllRooms,
            canDeleteAllRooms: user.canDeleteAllRooms,
        }

        next()
    } catch (error) {
        return res.status(401).json({ error: 'Invalid token' })
    }
}
