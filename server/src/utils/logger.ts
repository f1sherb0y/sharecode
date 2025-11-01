type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LOG_LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
}

const COLORS = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    // Foreground colors
    black: '\x1b[30m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m',
}

class Logger {
    private currentLevel: LogLevel

    constructor() {
        const envLevel = process.env.LOG_LEVEL?.toLowerCase() as LogLevel
        this.currentLevel = envLevel && LOG_LEVELS[envLevel] !== undefined ? envLevel : 'info'
    }

    private shouldLog(level: LogLevel): boolean {
        return LOG_LEVELS[level] >= LOG_LEVELS[this.currentLevel]
    }

    private formatTime(): string {
        const now = new Date()
        const hours = String(now.getHours()).padStart(2, '0')
        const minutes = String(now.getMinutes()).padStart(2, '0')
        const seconds = String(now.getSeconds()).padStart(2, '0')
        return `${hours}:${minutes}:${seconds}`
    }

    private log(level: LogLevel, message: string, ...args: any[]) {
        if (!this.shouldLog(level)) return

        const timestamp = `${COLORS.gray}[${this.formatTime()}]${COLORS.reset}`
        const levelColors: Record<LogLevel, string> = {
            debug: COLORS.cyan,
            info: COLORS.blue,
            warn: COLORS.yellow,
            error: COLORS.red,
        }

        const levelStr = `${levelColors[level]}${level.toUpperCase().padEnd(5)}${COLORS.reset}`
        console.log(`${timestamp} ${levelStr} ${message}`, ...args)
    }

    debug(message: string, ...args: any[]) {
        this.log('debug', message, ...args)
    }

    info(message: string, ...args: any[]) {
        this.log('info', message, ...args)
    }

    warn(message: string, ...args: any[]) {
        this.log('warn', message, ...args)
    }

    error(message: string, ...args: any[]) {
        this.log('error', message, ...args)
    }

    // Special formatters for common use cases
    http(method: string, path: string, status: number, duration: number, user?: string) {
        const statusColor = status >= 500 ? COLORS.red
            : status >= 400 ? COLORS.yellow
                : status >= 300 ? COLORS.cyan
                    : COLORS.green

        const methodColor = method === 'GET' ? COLORS.blue
            : method === 'POST' ? COLORS.green
                : method === 'PUT' ? COLORS.yellow
                    : method === 'DELETE' ? COLORS.red
                        : COLORS.white

        const userInfo = user ? `${COLORS.gray}[user: ${user}]${COLORS.reset}` : ''
        const msg = `${methodColor}${method.padEnd(6)}${COLORS.reset} ${path} ${COLORS.dim}→${COLORS.reset} ${statusColor}${status}${COLORS.reset} ${COLORS.gray}(${duration}ms)${COLORS.reset} ${userInfo}`

        this.info(msg)
    }

    success(message: string) {
        console.log(`${COLORS.green}[OK] ${message}${COLORS.reset}`)
    }

    heading(message: string) {
        console.log(`\n${COLORS.bright}${COLORS.cyan}${message}${COLORS.reset}`)
    }

    websocket(message: string) {
        console.log(`${COLORS.magenta}[WS] ${message}${COLORS.reset}`)
    }
}

export const logger = new Logger()
