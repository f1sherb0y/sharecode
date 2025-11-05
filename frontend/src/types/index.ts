export interface User {
    id: string
    email: string
    username: string
    color: string
    role?: Role
    canReadAllRooms?: boolean
    canWriteAllRooms?: boolean
    canDeleteAllRooms?: boolean
    createdAt?: string
    lastSeen?: string
}

export interface Room {
    id: string
    name: string
    language: string
    documentId: string
    ownerId: string
    allowEdit: boolean
    isDeleted?: boolean
    scheduledTime?: string
    duration?: number
    isEnded?: boolean
    endedAt?: string
    createdAt: string
    updatedAt: string
    owner: {
        id: string
        username: string
        color: string
    }
    participants?: Array<{
        user: {
            id: string
            username: string
            color: string
        }
    }>
    isExpired?: boolean
    isMember?: boolean
    isOwner?: boolean
    canEdit?: boolean
}

export interface AuthResponse {
    user: User
    token: string
}

export interface RemoteUser {
    clientId: number
    username: string
    color: string
    colorLight: string
    cursor?: {
        anchor: any
        head: any
    }
}

export type Role = 'user' | 'admin' | 'superuser'

export type Language =
    | 'javascript'
    | 'typescript'
    | 'python'
    | 'java'
    | 'cpp'
    | 'rust'
    | 'go'
    | 'php'
