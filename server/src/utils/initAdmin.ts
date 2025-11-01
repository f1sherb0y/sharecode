import bcrypt from 'bcrypt'
import { prisma } from './db'
import { logger } from './logger'

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

export async function initializeAdmin() {
    try {
        const adminUsername = process.env.ADMIN_USERNAME || 'admin'
        const adminPassword = process.env.ADMIN_PASSWORD || 'admin123'
        const adminEmail = process.env.ADMIN_EMAIL || 'admin@sharecode.local'

        // Check if admin user already exists
        const existingAdmin = await prisma.user.findFirst({
            where: { role: 'admin' },
        })

        if (!existingAdmin) {
            // Create new admin user
            const hashedPassword = await bcrypt.hash(adminPassword, 10)

            const admin = await prisma.user.create({
                data: {
                    username: adminUsername,
                    email: adminEmail,
                    password: hashedPassword,
                    color: getRandomColor(),
                    role: 'admin',
                },
            })

            logger.success(`Admin user created: ${admin.username}`)
            logger.info(`   Email: ${admin.email}`)
            logger.info(`   Password: ${adminPassword}`)
            logger.warn(`   [WARNING] Please change the default password in production!`)
        } else {
            logger.success(`Admin user already exists: ${existingAdmin.username}`)

            // Optional: Update admin password if it changed in environment
            if (process.env.ADMIN_UPDATE_PASSWORD === 'true') {
                const hashedPassword = await bcrypt.hash(adminPassword, 10)
                await prisma.user.update({
                    where: { id: existingAdmin.id },
                    data: { password: hashedPassword },
                })
                logger.success(`   Admin password updated`)
            }
        }
    } catch (error) {
        logger.error('[ERROR] Failed to initialize admin user:', error)
        // Don't throw - allow server to continue starting
    }
}
