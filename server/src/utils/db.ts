import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
    prisma: PrismaClient | undefined
}

// Only log queries in debug mode
const logLevel = process.env.LOG_LEVEL === 'debug'
    ? ['query', 'error', 'warn']
    : ['error', 'warn']

export const prisma =
    globalForPrisma.prisma ??
    new PrismaClient({
        log: logLevel as any,
    })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
