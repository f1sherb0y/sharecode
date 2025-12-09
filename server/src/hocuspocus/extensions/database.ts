import { Database } from '@hocuspocus/extension-database'
import { prisma } from '../../utils/db'
import { logger } from '../../utils/logger'

export const databaseExtension = new Database({
    fetch: async ({ documentName }) => {
        const doc = await prisma.document.findUnique({
            where: { name: documentName },
            select: { data: true },
        })

        if (doc?.data) {
            logger.debug(`[DB] Fetched document ${documentName} (${doc.data.length} bytes)`)
            return new Uint8Array(doc.data)
        }

        logger.debug(`[DB] No existing document found for ${documentName}`)
        return null
    },

    store: async ({ documentName, state }) => {
        await prisma.document.upsert({
            where: { name: documentName },
            update: {
                data: Buffer.from(state),
                updatedAt: new Date(),
            },
            create: {
                name: documentName,
                data: Buffer.from(state),
            },
        })
        logger.debug(`[DB] Stored document ${documentName} (${state.length} bytes)`)
    },
})
