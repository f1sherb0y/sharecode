import type { Request, Response, NextFunction } from 'express'
import { logger } from '../utils/logger'

export const requestLogger = (req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now()

    // Skip health check endpoint to reduce noise
    if (req.path === '/health') {
        return next()
    }

    // Capture the original send function
    const originalSend = res.send

    res.send = function (data: any) {
        res.send = originalSend

        const duration = Date.now() - startTime
        const username = (req as any).username || undefined

        logger.http(
            req.method,
            req.path,
            res.statusCode,
            duration,
            username
        )

        return originalSend.call(this, data)
    }

    next()
}
