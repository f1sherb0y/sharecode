import { Database } from '@hocuspocus/extension-database'
import { prisma } from '../../utils/db'

export const databaseExtension = new Database({
    fetch: async ({ documentName }) => {
        try {
            const doc = await prisma.document.findUnique({
                where: { name: documentName },
                select: { data: true },
            })

            if (doc?.data) {
                return new Uint8Array(doc.data)
            }

            return null
        } catch (error) {
            console.error('Error fetching document:', error)
            return null
        }
    },

    store: async ({ documentName, state }) => {
        try {
            await prisma.document.upsert({
                where: { name: documentName },
                update: {
                    data: Buffer.from(state),
                    updatedAt: new Date(),
                },
                create: {
                    name: documentName,
                    data: Buffer.from(state),
                    room: {
                        connect: { documentId: documentName },
                    },
                },
            })
        } catch (error) {
            console.error('Error storing document:', error)
        }
    },
})
