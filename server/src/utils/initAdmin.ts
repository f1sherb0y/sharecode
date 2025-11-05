import bcrypt from 'bcrypt'
import { prisma } from './db'
import { logger } from './logger'
import { getRandomUserColor } from './colors'

export async function initializeAdmin() {
    try {
        const adminUsername = process.env.ADMIN_USERNAME || 'admin'
        const adminPassword = process.env.ADMIN_PASSWORD || 'admin123'
        const adminEmail = process.env.ADMIN_EMAIL || 'admin@sharecode.local'

        // Check if a superuser already exists
        const existingSuperuser = await prisma.user.findFirst({
            where: { role: 'superuser', isDeleted: false },
        })

        if (existingSuperuser) {
            logger.success(`Superuser already exists: ${existingSuperuser.username}`)

            // Ensure permissions stay in sync
            if (
                !existingSuperuser.canReadAllRooms ||
                !existingSuperuser.canWriteAllRooms ||
                !existingSuperuser.canDeleteAllRooms
            ) {
                await prisma.user.update({
                    where: { id: existingSuperuser.id },
                    data: {
                        canReadAllRooms: true,
                        canWriteAllRooms: true,
                        canDeleteAllRooms: true,
                    },
                })
                logger.info(`   Superuser permissions updated`)
            }

            // Optional: Update password if requested
            if (process.env.ADMIN_UPDATE_PASSWORD === 'true') {
                const hashedPassword = await bcrypt.hash(adminPassword, 10)
                await prisma.user.update({
                    where: { id: existingSuperuser.id },
                    data: { password: hashedPassword },
                })
                logger.success(`   Superuser password updated`)
            }
            return
        }

        // Promote existing admin with configured username to superuser if present
        const userWithAdminUsername = await prisma.user.findUnique({
            where: { username: adminUsername },
        })

        if (userWithAdminUsername) {
            await prisma.user.update({
                where: { id: userWithAdminUsername.id },
                data: {
                    role: 'superuser',
                    canReadAllRooms: true,
                    canWriteAllRooms: true,
                    canDeleteAllRooms: true,
                },
            })
            logger.success(`Promoted existing user to superuser: ${userWithAdminUsername.username}`)
            return
        }

        // Create new superuser
        const hashedPassword = await bcrypt.hash(adminPassword, 10)

        const superuser = await prisma.user.create({
            data: {
                username: adminUsername,
                email: adminEmail,
                password: hashedPassword,
                color: getRandomUserColor(),
                role: 'superuser',
                canReadAllRooms: true,
                canWriteAllRooms: true,
                canDeleteAllRooms: true,
            },
        })

        logger.success(`Superuser created: ${superuser.username}`)
        logger.info(`   Email: ${superuser.email}`)
        logger.info(`   Password: ${adminPassword}`)
        logger.warn(`   [WARNING] Please change the default password in production!`)
    } catch (error) {
        logger.error('[ERROR] Failed to initialize admin user:', error)
        // Don't throw - allow server to continue starting
    }
}
