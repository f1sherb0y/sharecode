import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key'

interface JWTPayload {
    userId: string
    email: string
    username: string
    role: string
}

export const adminMiddleware = (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        const authHeader = req.headers.authorization
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'No token provided' })
        }

        const token = authHeader.substring(7)
        const decoded = jwt.verify(token, JWT_SECRET) as JWTPayload

        if (decoded.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' })
        }

        ; (req as any).userId = decoded.userId
        next()
    } catch (error) {
        return res.status(401).json({ error: 'Invalid token' })
    }
}
