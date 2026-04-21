export const MIN_PASSWORD_LENGTH = 10

export function validatePasswordPolicy(password: string): boolean {
  if (password.length < MIN_PASSWORD_LENGTH) return false
  if (/\s/.test(password)) return false
  if (!/[A-Z]/.test(password)) return false
  if (!/[a-z]/.test(password)) return false
  if (!/[0-9]/.test(password)) return false
  if (!/[^A-Za-z0-9]/.test(password)) return false
  return true
}
