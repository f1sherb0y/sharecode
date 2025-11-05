import type { Extension } from '@hocuspocus/server'
import { prisma } from '../../utils/db'

export const updatesExtension: Extension = {
    async onChange({ documentName, update, context }) {
        try {
            let actorId: string | null = null
            if (context?.sessionType === 'user' && context.user?.id) {
                actorId = context.user.id
            } else if (context?.sessionType === 'guest' && context.guest?.id) {
                actorId = context.guest.id
            }

            // Store the update in the database
            await prisma.documentUpdate.create({
                data: {
                    documentId: documentName,
                    update: Buffer.from(update),
                    userId: actorId,
                },
            })
        } catch (error) {
            console.error('Error storing document update:', error)
            // Don't throw - we don't want to break collaboration if storage fails
        }
    },
}
