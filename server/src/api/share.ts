import type { Request, Response } from 'express'
import { randomBytes } from 'crypto'
import { prisma } from '../utils/db'
import { getRandomUserColor } from '../utils/colors'
import { generateGuestToken, verifyToken } from '../utils/jwt'

function buildShareUrl(token: string, roomId: string) {
    const baseUrl = process.env.FRONTEND_URL || process.env.APP_URL
    if (!baseUrl) {
        return null
    }

    const normalizedBase = baseUrl.replace(/\/$/, '')
    const useHashRoutes = process.env.FRONTEND_HASH_ROUTER === 'true'
    const path = useHashRoutes ? `#/room/${roomId}?share=${token}` : `room/${roomId}?share=${token}`

    return useHashRoutes
        ? `${normalizedBase}/${path}`
        : `${normalizedBase}/${path}`
}

function ensureAuthorizationHeader(req: Request): string | null {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return null
    }
    return authHeader.substring(7)
}

function formatShareLink(link: { id: string; token: string; canEdit: boolean; createdAt: Date; guests: { id: string }[]; room: { id: string } }) {
    return {
        id: link.id,
        token: link.token,
        canEdit: link.canEdit,
        createdAt: link.createdAt,
        guestCount: link.guests.length,
        shareUrl: buildShareUrl(link.token, link.room.id),
    }
}

export async function createShareLink(req: Request, res: Response) {
    try {
        const { roomId } = req.params
        const { canEdit = false } = req.body as { canEdit?: boolean }
        const authUser = (req as any).authUser

        const room = await prisma.room.findUnique({
            where: { id: roomId },
            select: {
                id: true,
                ownerId: true,
                isDeleted: true,
                isEnded: true,
                allowEdit: true,
            },
        })

        if (!room || room.isDeleted) {
            return res.status(404).json({ error: 'Room not found' })
        }

        if (room.ownerId !== authUser.id) {
            return res.status(403).json({ error: 'Only the room owner can create share links' })
        }

        if (room.isEnded) {
            return res.status(400).json({ error: 'Cannot create share links for ended rooms' })
        }

        const token = randomBytes(24).toString('hex')

        const shareLink = await prisma.roomShareLink.create({
            data: {
                roomId: room.id,
                token,
                canEdit: Boolean(canEdit) && room.allowEdit,
                createdBy: authUser.id,
            },
            include: {
                guests: true,
                room: {
                    select: {
                        id: true,
                    },
                },
            },
        })

        res.status(201).json({
            shareLink: formatShareLink(shareLink),
        })
    } catch (error) {
        console.error('Create share link error:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
}

export async function listShareLinks(req: Request, res: Response) {
    try {
        const { roomId } = req.params
        const authUser = (req as any).authUser

        const room = await prisma.room.findUnique({
            where: { id: roomId },
            select: { id: true, ownerId: true },
        })

        if (!room) {
            return res.status(404).json({ error: 'Room not found' })
        }

        if (room.ownerId !== authUser.id) {
            return res.status(403).json({ error: 'Only the room owner can view share links' })
        }

        const shareLinks = await prisma.roomShareLink.findMany({
            where: { roomId: room.id },
            include: {
                guests: {
                    select: {
                        id: true,
                    },
                },
                room: {
                    select: {
                        id: true,
                    },
                },
            },
            orderBy: { createdAt: 'desc' },
        })

        res.json({
            shareLinks: shareLinks.map(formatShareLink),
        })
    } catch (error) {
        console.error('List share links error:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
}

export async function deleteShareLink(req: Request, res: Response) {
    try {
        const { roomId, shareLinkId } = req.params
        const authUser = (req as any).authUser

        const shareLink = await prisma.roomShareLink.findUnique({
            where: { id: shareLinkId },
            include: {
                room: {
                    select: {
                        id: true,
                        ownerId: true,
                    },
                },
            },
        })

        if (!shareLink || shareLink.roomId !== roomId) {
            return res.status(404).json({ error: 'Share link not found' })
        }

        if (shareLink.room.ownerId !== authUser.id) {
            return res.status(403).json({ error: 'Only the room owner can delete share links' })
        }

        await prisma.roomShareLink.delete({
            where: { id: shareLinkId },
        })

        res.json({ message: 'Share link deleted' })
    } catch (error) {
        console.error('Delete share link error:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
}

export async function getShareInfo(req: Request, res: Response) {
    try {
        const { token } = req.params

        const shareLink = await prisma.roomShareLink.findUnique({
            where: { token },
            include: {
                room: {
                    select: {
                        id: true,
                        name: true,
                        language: true,
                        allowEdit: true,
                        isDeleted: true,
                        isEnded: true,
                        endedAt: true,
                    },
                },
            },
        })

        if (!shareLink || shareLink.room.isDeleted) {
            return res.status(404).json({ error: 'Share link not found' })
        }

        const effectiveCanEdit = shareLink.canEdit && shareLink.room.allowEdit && !shareLink.room.isEnded

        res.json({
            share: {
                token: shareLink.token,
                canEdit: shareLink.canEdit,
                effectiveCanEdit,
                createdAt: shareLink.createdAt,
                shareUrl: buildShareUrl(shareLink.token),
            },
            room: {
                id: shareLink.room.id,
                name: shareLink.room.name,
                language: shareLink.room.language,
                isEnded: shareLink.room.isEnded,
                endedAt: shareLink.room.endedAt,
            },
        })
    } catch (error) {
        console.error('Get share info error:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
}

export async function joinShareLink(req: Request, res: Response) {
    try {
        const { token } = req.params
        const { username, email } = req.body as { username?: string; email?: string }

        const normalizedUsername = (username ?? '').trim()
        const trimmedEmail = email?.trim() ?? ''
        const normalizedEmail = trimmedEmail.length > 0 ? trimmedEmail : null

        if (!normalizedUsername) {
            return res.status(400).json({ error: 'Username is required' })
        }

        const shareLink = await prisma.roomShareLink.findUnique({
            where: { token },
            include: {
                room: {
                    select: {
                        id: true,
                        name: true,
                        language: true,
                        allowEdit: true,
                        isDeleted: true,
                        isEnded: true,
                        endedAt: true,
                    },
                },
            },
        })

        if (!shareLink || shareLink.room.isDeleted) {
            return res.status(404).json({ error: 'Share link not found' })
        }

        if (shareLink.room.isEnded) {
            return res.status(400).json({ error: 'This room has already ended' })
        }

        const sessionToken = randomBytes(24).toString('hex')
        const guestColor: string = getRandomUserColor()
        const canEdit = shareLink.canEdit && shareLink.room.allowEdit

        const guest = await prisma.guestSession.create({
            data: {
                shareLinkId: shareLink.id,
                roomId: shareLink.room.id,
                token: sessionToken,
                displayName: normalizedUsername,
                email: normalizedEmail,
                color: guestColor,
                canEdit,
            },
        })

        const jwtToken = generateGuestToken({
            guestId: guest.id,
            roomId: shareLink.room.id,
            shareLinkId: shareLink.id,
            displayName: guest.displayName,
            email: guest.email,
            color: guest.color,
            canEdit: guest.canEdit,
            sessionToken,
        })

        res.status(201).json({
            token: jwtToken,
            guest: {
                id: guest.id,
                displayName: guest.displayName,
                email: guest.email,
                color: guest.color,
                canEdit: guest.canEdit,
            },
            room: {
                id: shareLink.room.id,
                name: shareLink.room.name,
                language: shareLink.room.language,
                documentId: shareLink.room.id,
                allowEdit: shareLink.room.allowEdit,
                isEnded: shareLink.room.isEnded,
                endedAt: shareLink.room.endedAt,
            },
        })
    } catch (error) {
        console.error('Join share link error:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
}

export async function getGuestSession(req: Request, res: Response) {
    try {
        const rawToken = ensureAuthorizationHeader(req)
        if (!rawToken) {
            return res.status(401).json({ error: 'No token provided' })
        }

        const payload = verifyToken(rawToken)
        if (payload.type !== 'guest') {
            return res.status(401).json({ error: 'Invalid token' })
        }

        const guest = await prisma.guestSession.findUnique({
            where: { id: payload.guestId },
            include: {
                room: {
                    select: {
                        id: true,
                        name: true,
                        language: true,
                        allowEdit: true,
                        isDeleted: true,
                        isEnded: true,
                        endedAt: true,
                    },
                },
                shareLink: {
                    select: {
                        id: true,
                        token: true,
                        canEdit: true,
                    },
                },
            },
        })

        if (!guest) {
            return res.status(404).json({ error: 'Session not found' })
        }

        if (guest.token !== payload.sessionToken) {
            return res.status(401).json({ error: 'Session token mismatch' })
        }

        if (guest.room.isDeleted) {
            return res.status(410).json({ error: 'Room no longer available' })
        }

        const effectiveCanEdit = guest.canEdit && guest.room.allowEdit && !guest.room.isEnded

        await prisma.guestSession.update({
            where: { id: guest.id },
            data: { lastActive: new Date(), canEdit: effectiveCanEdit },
        })

        res.json({
            guest: {
                id: guest.id,
                displayName: guest.displayName,
                email: guest.email,
                color: guest.color,
                canEdit: effectiveCanEdit,
            },
            room: {
                id: guest.room.id,
                name: guest.room.name,
                language: guest.room.language,
                documentId: guest.room.id,
                allowEdit: guest.room.allowEdit,
                isEnded: guest.room.isEnded,
                endedAt: guest.room.endedAt,
            },
            share: {
                id: guest.shareLink.id,
                token: guest.shareLink.token,
                canEdit: guest.shareLink.canEdit,
            },
        })
    } catch (error) {
        console.error('Get guest session error:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
}
