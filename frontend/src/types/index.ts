export interface User {
    id: string
    email: string
    username: string
    color: string
}

export interface Room {
    id: string
    name: string
    language: string
    documentId: string
    ownerId: string
    allowEdit: boolean
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

export type Language =
    | 'javascript'
    | 'typescript'
    | 'python'
    | 'java'
    | 'cpp'
    | 'rust'
    | 'go'
    | 'php'
