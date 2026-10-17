/** Peers publish `followable: false` to opt out; older clients omit it and stay followable. */
export function isFollowable(state: unknown): boolean {
  return (state as { followable?: unknown } | undefined)?.followable !== false
}

/** Paused follows ('blocked': presenter opted out, 'away': presenter offline) resume by themselves. */
export type FollowStatus = 'active' | 'blocked' | 'away'
