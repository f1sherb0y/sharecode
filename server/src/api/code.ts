import type { Request, Response } from 'express'
import { logger } from '../utils/logger'

const PISTON_URL = process.env.PISTON_URL || 'http://localhost:2000'

interface ExecuteRequest {
    source_code: string
    language_id: string  // Now using language name
    stdin?: string
}

interface PistonExecuteRequest {
    language: string
    version: string
    files: Array<{
        name?: string
        content: string
    }>
    stdin?: string
    run_timeout?: number
    compile_timeout?: number
    run_memory_limit?: number
    compile_memory_limit?: number
}

interface PistonResult {
    language: string
    version: string
    run: {
        stdout: string
        stderr: string
        output: string
        code: number | null
        signal: string | null
        message?: string | null
        status?: string | null
    }
    compile?: {
        stdout: string
        stderr: string
        output: string
        code: number | null
        signal: string | null
        message?: string | null
        status?: string | null
    }
}

interface PistonRuntime {
    language: string
    version: string
    aliases: string[]
    runtime?: string
}

// Language name mapping (editor language -> piston language)
export const LANGUAGE_MAP: Record<string, string> = {
    'c': 'c',
    'cpp': 'c++',
    'csharp': 'csharp',
    'go': 'go',
    'java': 'java',
    'javascript': 'javascript',
    'typescript': 'typescript',
    'python': 'python',
    'rust': 'rust',
    'ruby': 'ruby',
    'php': 'php',
    'swift': 'swift',
    'kotlin': 'kotlin',
    'scala': 'scala',
    'r': 'rscript',
    'perl': 'perl',
    'lua': 'lua',
    'haskell': 'haskell',
    'bash': 'bash',
    'sql': 'sqlite3',
    'plaintext': 'bash',  // Just echo for plaintext
}

// File extensions for each language
const FILE_EXTENSIONS: Record<string, string> = {
    'c': 'c',
    'c++': 'cpp',
    'csharp': 'cs',
    'go': 'go',
    'java': 'java',
    'javascript': 'js',
    'typescript': 'ts',
    'python': 'py',
    'rust': 'rs',
    'ruby': 'rb',
    'php': 'php',
    'swift': 'swift',
    'kotlin': 'kt',
    'scala': 'scala',
    'rscript': 'r',
    'perl': 'pl',
    'lua': 'lua',
    'haskell': 'hs',
    'bash': 'sh',
    'sqlite3': 'sql',
}

// Cache for available runtimes
let runtimesCache: PistonRuntime[] | null = null
let runtimesCacheTime = 0
const CACHE_TTL = 60000 // 1 minute

async function pistonRequest<T>(
    endpoint: string,
    method: 'GET' | 'POST' = 'GET',
    body?: unknown
): Promise<T> {
    const response = await fetch(`${PISTON_URL}/api/v2${endpoint}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
    })

    if (!response.ok) {
        const text = await response.text()
        throw new Error(`Piston API error: ${response.status} - ${text}`)
    }

    return response.json()
}

async function getRuntimes(): Promise<PistonRuntime[]> {
    const now = Date.now()
    if (runtimesCache && now - runtimesCacheTime < CACHE_TTL) {
        return runtimesCache
    }

    runtimesCache = await pistonRequest<PistonRuntime[]>('/runtimes')
    runtimesCacheTime = now
    return runtimesCache
}

async function findRuntime(language: string): Promise<{ language: string; version: string } | null> {
    const runtimes = await getRuntimes()

    // Find matching runtime
    const runtime = runtimes.find(r =>
        r.language === language ||
        r.aliases?.includes(language)
    )

    if (runtime) {
        return { language: runtime.language, version: runtime.version }
    }

    return null
}

export async function executeCode(req: Request, res: Response) {
    try {
        const authUser = (req as any).authUser
        if (!authUser) {
            return res.status(401).json({ error: 'Authentication required' })
        }

        const { source_code, language_id, stdin } = req.body as ExecuteRequest

        if (!source_code) {
            return res.status(400).json({ error: 'Source code is required' })
        }

        if (!language_id) {
            return res.status(400).json({ error: 'Language ID is required' })
        }

        // Map editor language to Piston language
        const pistonLang = LANGUAGE_MAP[language_id] || language_id

        logger.debug(`Executing code for user ${authUser.id}, language: ${language_id} -> ${pistonLang}`)

        // Find runtime version
        const runtime = await findRuntime(pistonLang)
        if (!runtime) {
            return res.status(400).json({
                error: `Language '${language_id}' is not supported`,
                output: '',
                status: 'Language Not Found',
                statusId: 0,
                isSuccess: false,
            })
        }

        // Get file extension
        const ext = FILE_EXTENSIONS[runtime.language] || 'txt'
        const fileName = `main.${ext}`

        // Build Piston request
        const pistonReq: PistonExecuteRequest = {
            language: runtime.language,
            version: runtime.version,
            files: [{
                name: fileName,
                content: source_code,
            }],
            stdin: stdin || '',
            run_timeout: 10000,      // 10 seconds
            compile_timeout: 10000,  // 10 seconds
            run_memory_limit: -1,    // No limit (let Piston defaults handle it)
            compile_memory_limit: -1,
        }

        const result = await pistonRequest<PistonResult>('/execute', 'POST', pistonReq)

        // Format response to match frontend expectations
        const output = result.run?.stdout || ''
        const compileError = result.compile?.stderr || result.compile?.output || ''
        const runError = result.run?.stderr || ''
        const error = compileError || runError

        // Determine status
        let status = 'Accepted'
        let statusId = 3  // Success
        let isSuccess = true

        if (result.compile?.code !== null && result.compile?.code !== 0) {
            status = 'Compilation Error'
            statusId = 6
            isSuccess = false
        } else if (result.run?.signal) {
            status = `Runtime Error (${result.run.signal})`
            statusId = 11
            isSuccess = false
        } else if (result.run?.code !== null && result.run?.code !== 0) {
            status = 'Runtime Error'
            statusId = 11
            isSuccess = false
        } else if (result.run?.status === 'TO') {
            status = 'Time Limit Exceeded'
            statusId = 5
            isSuccess = false
        } else if (result.run?.message) {
            status = result.run.message
            statusId = 11
            isSuccess = false
        }

        res.json({
            output,
            error,
            status,
            statusId,
            isSuccess,
            time: null,  // Piston doesn't return execution time in the same format
            memory: null,
        })
    } catch (error) {
        logger.error('Code execution error:', error)
        res.status(500).json({
            error: 'Code execution failed',
            message: error instanceof Error ? error.message : 'Unknown error',
            output: '',
            status: 'Internal Error',
            statusId: 13,
            isSuccess: false,
        })
    }
}

export async function getLanguages(_req: Request, res: Response) {
    try {
        // Get available runtimes from Piston
        const runtimes = await getRuntimes()

        // Map to our supported languages
        const languages = Object.entries(LANGUAGE_MAP)
            .map(([editorLang, pistonLang]) => {
                const runtime = runtimes.find(r =>
                    r.language === pistonLang ||
                    r.aliases?.includes(pistonLang)
                )
                return {
                    name: editorLang,
                    id: editorLang,  // Use name as ID for Piston
                    version: runtime?.version || 'unknown',
                    available: !!runtime,
                }
            })
            .filter(l => l.available)

        res.json({ languages })
    } catch (error) {
        logger.error('Get languages error:', error)
        res.status(500).json({ error: 'Failed to get languages' })
    }
}

export async function checkPistonHealth(_req: Request, res: Response) {
    try {
        const runtimes = await pistonRequest<PistonRuntime[]>('/runtimes')
        res.json({
            status: 'ok',
            piston: {
                runtimes: runtimes.length,
                languages: runtimes.map(r => r.language)
            }
        })
    } catch (error) {
        logger.error('Piston health check failed:', error)
        res.status(503).json({
            status: 'error',
            error: 'Piston is not available'
        })
    }
}

// Keep old function name for compatibility
export const checkJudge0Health = checkPistonHealth
