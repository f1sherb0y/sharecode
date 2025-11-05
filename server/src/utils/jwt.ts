import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key'

interface BaseTokenPayload {
    type: 'user' | 'guest'
    exp?: number
    iat?: number
}

export interface UserTokenPayload extends BaseTokenPayload {
    type: 'user'
    userId: string
    email: string | null
    username: string
    role: string
    canReadAllRooms: boolean
    canWriteAllRooms: boolean
    canDeleteAllRooms: boolean
}

export interface GuestTokenPayload extends BaseTokenPayload {
    type: 'guest'
    guestId: string
    roomId: string
    shareLinkId: string
    displayName: string
    email: string | null
    color: string
    canEdit: boolean
    sessionToken: string
}

export type TokenPayload = UserTokenPayload | GuestTokenPayload

export function generateUserToken(payload: Omit<UserTokenPayload, 'type' | 'exp' | 'iat'>): string {
    const data: UserTokenPayload = {
        ...payload,
        type: 'user',
    }
    return jwt.sign(data, JWT_SECRET, {
        expiresIn: '7d',
    })
}

export function generateGuestToken(payload: Omit<GuestTokenPayload, 'type' | 'exp' | 'iat'>): string {
    const data: GuestTokenPayload = {
        ...payload,
        type: 'guest',
    }
    return jwt.sign(data, JWT_SECRET, {
        expiresIn: '24h',
    })
}

export function verifyToken(token: string): TokenPayload {
    try {
        return jwt.verify(token, JWT_SECRET) as TokenPayload
    } catch (error) {
        throw new Error('Invalid token')
    }
}
