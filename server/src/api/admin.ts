import type { Request, Response } from 'express'
import bcrypt from 'bcrypt'
import { prisma } from '../utils/db'

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

type Role = 'user' | 'admin' | 'superuser'

interface AuthUser {
    id: string
    role: Role
    canReadAllRooms: boolean
    canWriteAllRooms: boolean
    canDeleteAllRooms: boolean
}

interface PermissionFlags {
    canReadAllRooms: boolean
    canWriteAllRooms: boolean
    canDeleteAllRooms: boolean
}

type PartialPermissionFlags = Partial<PermissionFlags>

function getRandomColor() {
    return USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)]
}

function getAuthUser(req: Request): AuthUser | undefined {
    return (req as any).authUser as AuthUser | undefined
}

function normalizeBoolean(value: unknown): boolean | undefined {
    if (value === undefined || value === null) return undefined
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase()
        if (normalized === 'true') return true
        if (normalized === 'false') return false
    }
    return Boolean(value)
}

function extractPermissionInput(body: any): PartialPermissionFlags {
    const source = body?.permissions ?? body ?? {}
    const result: PartialPermissionFlags = {}

    const read = normalizeBoolean(source.canReadAllRooms)
    const write = normalizeBoolean(source.canWriteAllRooms)
    const del = normalizeBoolean(source.canDeleteAllRooms)

    if (read !== undefined) result.canReadAllRooms = read
    if (write !== undefined) result.canWriteAllRooms = write
    if (del !== undefined) result.canDeleteAllRooms = del

    return result
}

function mergePermissions(current: PermissionFlags, updates: PartialPermissionFlags): PermissionFlags {
    return {
        canReadAllRooms: updates.canReadAllRooms ?? current.canReadAllRooms,
        canWriteAllRooms: updates.canWriteAllRooms ?? current.canWriteAllRooms,
        canDeleteAllRooms: updates.canDeleteAllRooms ?? current.canDeleteAllRooms,
    }
}

function applyPermissionHierarchy(perms: PermissionFlags): PermissionFlags {
    const result = { ...perms }

    if (result.canDeleteAllRooms) {
        result.canWriteAllRooms = true
        result.canReadAllRooms = true
    } else if (result.canWriteAllRooms) {
        result.canReadAllRooms = true
    }

    return result
}

function normalizePermissionsForRole(role: Role, permissions: PermissionFlags): PermissionFlags {
    if (role === 'superuser') {
        return {
            canReadAllRooms: true,
            canWriteAllRooms: true,
            canDeleteAllRooms: true,
        }
    }

    const normalized = applyPermissionHierarchy(permissions)

    if (role === 'admin') {
        normalized.canReadAllRooms = true
        normalized.canWriteAllRooms = true
        return applyPermissionHierarchy(normalized)
    }

    return normalized
}

function defaultPermissionsForRole(role: Role, requested?: PartialPermissionFlags): PermissionFlags {
    const base: PermissionFlags =
        role === 'admin'
            ? { canReadAllRooms: true, canWriteAllRooms: true, canDeleteAllRooms: false }
            : { canReadAllRooms: false, canWriteAllRooms: false, canDeleteAllRooms: false }

    const merged = mergePermissions(base, requested ?? {})
    return normalizePermissionsForRole(role, merged)
}

const VALID_ROLES: Role[] = ['user', 'admin', 'superuser']

export async function createUser(req: Request, res: Response) {
    try {
        const authUser = getAuthUser(req)
        if (!authUser) {
            return res.status(401).json({ error: 'Authentication required' })
        }

        const { username, password, email } = req.body
        const requestedRole = (req.body.role as Role | undefined) ?? 'user'

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' })
        }

        if (!VALID_ROLES.includes(requestedRole)) {
            return res.status(400).json({ error: 'Invalid role' })
        }

        if (authUser.role === 'admin' && requestedRole !== 'user') {
            return res.status(403).json({ error: 'Admins can only create normal users' })
        }

        if (authUser.role !== 'superuser' && requestedRole === 'superuser') {
            return res.status(403).json({ error: 'Only superusers can create other superusers' })
        }

        if (authUser.role !== 'superuser' && requestedRole === 'admin') {
            return res.status(403).json({ error: 'Only superusers can create admins' })
        }

        const existingUser = await prisma.user.findUnique({
            where: { username },
        })

        if (existingUser) {
            return res.status(400).json({ error: 'Username already taken' })
        }

        if (email) {
            const existingEmail = await prisma.user.findUnique({
                where: { email },
            })

            if (existingEmail) {
                return res.status(400).json({ error: 'Email already in use' })
            }
        }

        const hashedPassword = await bcrypt.hash(password, 10)

        const requestedPermissions = extractPermissionInput(req.body)
        const permissions = defaultPermissionsForRole(requestedRole, requestedPermissions)

        const user = await prisma.user.create({
            data: {
                email,
                username,
                password: hashedPassword,
                color: getRandomColor(),
                role: requestedRole,
                canReadAllRooms: permissions.canReadAllRooms,
                canWriteAllRooms: permissions.canWriteAllRooms,
                canDeleteAllRooms: permissions.canDeleteAllRooms,
            },
            select: {
                id: true,
                email: true,
                username: true,
                color: true,
                role: true,
                canReadAllRooms: true,
                canWriteAllRooms: true,
                canDeleteAllRooms: true,
                createdAt: true,
                lastSeen: true,
            },
        })

        res.status(201).json({ user })
    } catch (error) {
        console.error('Create user error:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
}

export async function getAllUsers(req: Request, res: Response) {
    try {
        const users = await prisma.user.findMany({
            where: {
                isDeleted: false,
            },
            select: {
                id: true,
                email: true,
                username: true,
                color: true,
                role: true,
                canReadAllRooms: true,
                canWriteAllRooms: true,
                canDeleteAllRooms: true,
                createdAt: true,
                lastSeen: true,
            },
            orderBy: {
                createdAt: 'desc',
            },
        })

        res.json({ users })
    } catch (error) {
        console.error('Get all users error:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
}

export async function updateUser(req: Request, res: Response) {
    try {
        const authUser = getAuthUser(req)
        if (!authUser) {
            return res.status(401).json({ error: 'Authentication required' })
        }

        const { id } = req.params
        const requestedRole = req.body.role as Role | undefined
        const permissionUpdates = extractPermissionInput(req.body)
        const hasPermissionChanges = inObject(permissionUpdates)

        const targetUser = await prisma.user.findUnique({
            where: { id },
        })

        if (!targetUser || targetUser.isDeleted) {
            return res.status(404).json({ error: 'User not found' })
        }

        if (targetUser.id === authUser.id && requestedRole && requestedRole !== 'superuser') {
            return res.status(403).json({ error: 'Cannot change your own role to a non-superuser role' })
        }

        if (authUser.role === 'admin' && targetUser.role !== 'user') {
            return res.status(403).json({ error: 'Admins can manage normal users only' })
        }

        if (requestedRole && !VALID_ROLES.includes(requestedRole)) {
            return res.status(400).json({ error: 'Invalid role' })
        }

        if (requestedRole && authUser.role !== 'superuser') {
            return res.status(403).json({ error: 'Only superusers can change roles' })
        }

        if (requestedRole === 'superuser' && authUser.role !== 'superuser') {
            return res.status(403).json({ error: 'Only superusers can promote to superuser' })
        }

        if (hasPermissionChanges && authUser.role !== 'superuser' && targetUser.role !== 'user') {
            return res.status(403).json({ error: 'Admins can only update permissions for normal users' })
        }

        if (targetUser.role === 'superuser' && requestedRole && requestedRole !== 'superuser') {
            const superuserCount = await prisma.user.count({
                where: { role: 'superuser', isDeleted: false },
            })

            if (superuserCount <= 1) {
                return res.status(403).json({ error: 'Cannot remove the last superuser' })
            }
        }

        const currentPermissions: PermissionFlags = {
            canReadAllRooms: targetUser.canReadAllRooms,
            canWriteAllRooms: targetUser.canWriteAllRooms,
            canDeleteAllRooms: targetUser.canDeleteAllRooms,
        }

        let permissions = currentPermissions
        if (hasPermissionChanges) {
            permissions = mergePermissions(currentPermissions, permissionUpdates)
        }

        const finalRole = requestedRole ?? (targetUser.role as Role)
        permissions = normalizePermissionsForRole(finalRole, permissions)

        const updatedUser = await prisma.user.update({
            where: { id },
            data: {
                role: finalRole,
                canReadAllRooms: permissions.canReadAllRooms,
                canWriteAllRooms: permissions.canWriteAllRooms,
                canDeleteAllRooms: permissions.canDeleteAllRooms,
            },
            select: {
                id: true,
                email: true,
                username: true,
                color: true,
                role: true,
                canReadAllRooms: true,
                canWriteAllRooms: true,
                canDeleteAllRooms: true,
                createdAt: true,
                lastSeen: true,
            },
        })

        res.json({ user: updatedUser })
    } catch (error) {
        console.error('Update user error:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
}

export async function deleteUser(req: Request, res: Response) {
    try {
        const authUser = getAuthUser(req)
        if (!authUser) {
            return res.status(401).json({ error: 'Authentication required' })
        }

        const { id } = req.params

        const user = await prisma.user.findUnique({
            where: { id },
        })

        if (!user || user.isDeleted) {
            return res.status(404).json({ error: 'User not found' })
        }

        if (id === authUser.id) {
            return res.status(403).json({ error: 'Cannot delete your own account' })
        }

        if (authUser.role === 'admin' && user.role !== 'user') {
            return res.status(403).json({ error: 'Admins can only delete normal users' })
        }

        if (user.role === 'superuser') {
            if (authUser.role !== 'superuser') {
                return res.status(403).json({ error: 'Only superusers can delete another superuser' })
            }

            const superuserCount = await prisma.user.count({
                where: {
                    role: 'superuser',
                    isDeleted: false,
                },
            })

            if (superuserCount <= 1) {
                return res.status(403).json({ error: 'Cannot delete the last superuser' })
            }
        }

        if (user.role === 'admin' && authUser.role !== 'superuser') {
            return res.status(403).json({ error: 'Only superusers can delete admins' })
        }

        if (user.role === 'admin') {
            const adminCount = await prisma.user.count({
                where: {
                    role: 'admin',
                    isDeleted: false,
                },
            })

            if (adminCount <= 1) {
                return res.status(403).json({ error: 'Cannot delete the last admin user' })
            }
        }

        await prisma.user.update({
            where: { id },
            data: { isDeleted: true },
        })

        res.json({ message: 'User deleted successfully' })
    } catch (error) {
        console.error('Delete user error:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
}

export async function getAllRooms(req: Request, res: Response) {
    try {
        const rooms = await prisma.room.findMany({
            where: {
                isDeleted: false,
            },
            include: {
                owner: {
                    select: {
                        id: true,
                        username: true,
                        email: true,
                    },
                },
                participants: {
                    include: {
                        user: {
                            select: {
                                id: true,
                                username: true,
                            },
                        },
                    },
                },
            },
            orderBy: {
                createdAt: 'desc',
            },
        })

        res.json({ rooms })
    } catch (error) {
        console.error('Get all rooms error:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
}

export async function deleteRoom(req: Request, res: Response) {
    try {
        const authUser = getAuthUser(req)
        if (!authUser) {
            return res.status(401).json({ error: 'Authentication required' })
        }

        if (!authUser.canDeleteAllRooms && authUser.role !== 'superuser') {
            return res.status(403).json({ error: 'Delete-all-rooms permission required' })
        }

        const { id } = req.params

        await prisma.room.update({
            where: { id },
            data: { isDeleted: true },
        })

        res.json({ message: 'Room deleted successfully' })
    } catch (error) {
        console.error('Delete room error:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
}

function inObject(obj: PartialPermissionFlags): boolean {
    return Object.keys(obj).length > 0
}
