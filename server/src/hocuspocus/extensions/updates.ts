import type { Extension } from '@hocuspocus/server'
import { prisma } from '../../utils/db'

export const updatesExtension: Extension = {
    async onChange({ documentName, update, context }) {
        try {
            // Store the update in the database
            await prisma.documentUpdate.create({
                data: {
                    documentId: documentName,
                    update: Buffer.from(update),
                    userId: context.user?.id || null,
                },
            })
        } catch (error) {
            console.error('Error storing document update:', error)
            // Don't throw - we don't want to break collaboration if storage fails
        }
    },
}
