import type { Request, Response } from 'express'
import { logger } from '../utils/logger'

const JUDGE0_URL = process.env.JUDGE0_URL || 'http://localhost:2358'
const JUDGE0_AUTH_TOKEN = process.env.JUDGE0_AUTH_TOKEN || ''

interface ExecuteRequest {
    source_code: string
    language_id: number
    stdin?: string
}

interface Judge0Submission {
    source_code: string
    language_id: number
    stdin?: string
    expected_output?: string
}

interface Judge0Result {
    token?: string
    stdout?: string | null
    stderr?: string | null
    compile_output?: string | null
    message?: string | null
    status?: {
        id: number
        description: string
    }
    time?: string
    memory?: number
}

// Language ID mapping for Judge0
// https://ce.judge0.com/languages
export const LANGUAGE_MAP: Record<string, number> = {
    'c': 50,           // C (GCC 9.2.0)
    'cpp': 54,         // C++ (GCC 9.2.0)
    'csharp': 51,      // C# (Mono 6.6.0.161)
    'go': 60,          // Go (1.13.5)
    'java': 62,        // Java (OpenJDK 13.0.1)
    'javascript': 63,  // JavaScript (Node.js 12.14.0)
    'typescript': 74,  // TypeScript (3.7.4)
    'python': 71,      // Python (3.8.1)
    'rust': 73,        // Rust (1.40.0)
    'ruby': 72,        // Ruby (2.7.0)
    'php': 68,         // PHP (7.4.1)
    'swift': 83,       // Swift (5.2.3)
    'kotlin': 78,      // Kotlin (1.3.70)
    'scala': 81,       // Scala (2.13.2)
    'r': 80,           // R (4.0.0)
    'perl': 85,        // Perl (5.28.1)
    'lua': 64,         // Lua (5.3.5)
    'haskell': 61,     // Haskell (GHC 8.8.1)
    'bash': 46,        // Bash (5.0.0)
    'sql': 82,         // SQL (SQLite 3.27.2)
    'plaintext': 43,   // Plain Text (will just echo)
}

async function judge0Request(
    endpoint: string,
    method: 'GET' | 'POST' = 'GET',
    body?: unknown
): Promise<unknown> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    }

    if (JUDGE0_AUTH_TOKEN) {
        headers['X-Auth-Token'] = JUDGE0_AUTH_TOKEN
    }

    const response = await fetch(`${JUDGE0_URL}${endpoint}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    })

    if (!response.ok) {
        const text = await response.text()
        throw new Error(`Judge0 API error: ${response.status} - ${text}`)
    }

    return response.json()
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

        logger.debug(`Executing code for user ${authUser.id}, language: ${language_id}`)

        // Create submission with wait=true to get result immediately
        const submission: Judge0Submission = {
            source_code,
            language_id,
            stdin: stdin || '',
        }

        const result = await judge0Request(
            '/submissions?base64_encoded=false&wait=true',
            'POST',
            submission
        ) as Judge0Result

        // Format response
        const output = result.stdout || ''
        const error = result.stderr || result.compile_output || ''
        const status = result.status?.description || 'Unknown'
        const statusId = result.status?.id || 0

        // Status IDs: 1=In Queue, 2=Processing, 3=Accepted, 4=Wrong Answer, 5=Time Limit,
        // 6=Compilation Error, 7-12=Runtime Errors, 13=Internal Error, 14=Exec Format Error
        const isSuccess = statusId === 3

        res.json({
            output,
            error,
            status,
            statusId,
            isSuccess,
            time: result.time,
            memory: result.memory,
        })
    } catch (error) {
        logger.error('Code execution error:', error)
        res.status(500).json({
            error: 'Code execution failed',
            message: error instanceof Error ? error.message : 'Unknown error'
        })
    }
}

export async function getLanguages(_req: Request, res: Response) {
    try {
        // Return our supported language mapping
        const languages = Object.entries(LANGUAGE_MAP).map(([name, id]) => ({
            name,
            id,
        }))

        res.json({ languages })
    } catch (error) {
        logger.error('Get languages error:', error)
        res.status(500).json({ error: 'Failed to get languages' })
    }
}

export async function checkJudge0Health(_req: Request, res: Response) {
    try {
        const result = await judge0Request('/about')
        res.json({ status: 'ok', judge0: result })
    } catch (error) {
        logger.error('Judge0 health check failed:', error)
        res.status(503).json({
            status: 'error',
            error: 'Judge0 is not available'
        })
    }
}
