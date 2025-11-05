import type { Request, Response, NextFunction } from 'express'

export const adminMiddleware = (req: Request, res: Response, next: NextFunction) => {
    const authUser = (req as any).authUser

    if (!authUser) {
        return res.status(401).json({ error: 'Authentication required' })
    }

    if (authUser.role !== 'admin' && authUser.role !== 'superuser') {
        return res.status(403).json({ error: 'Admin access required' })
    }

    next()
}
