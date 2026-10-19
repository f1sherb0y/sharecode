/** Where signing in leads: back to the work table link it came from (`?next=`), else the rooms. */
export function afterLogin(search: string): string {
  const next = new URLSearchParams(search).get('next') ?? ''
  return /^\/t\/[A-Za-z0-9]+$/.test(next) ? next : '/rooms'
}
