import type { Request, Response, NextFunction } from 'express'
import { verifyToken } from '../utils/jwt'

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
    try {
        const authHeader = req.headers.authorization

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'No token provided' })
        }

        const token = authHeader.substring(7)
        const decoded = verifyToken(token)

            // Add userId to request
            ; (req as any).userId = decoded.userId
        next()
    } catch (error) {
        return res.status(401).json({ error: 'Invalid token' })
    }
}
