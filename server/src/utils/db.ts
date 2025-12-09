import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
    prisma: PrismaClient | undefined
}

// Only log errors by default, hide query logs to reduce noise
const logLevel = process.env.PRISMA_LOG === 'true'
    ? ['query', 'error', 'warn']
    : ['error']

export const prisma =
    globalForPrisma.prisma ??
    new PrismaClient({
        log: logLevel as any,
    })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
