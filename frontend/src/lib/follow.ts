/** Peers publish `followable: false` to opt out; older clients omit it and stay followable. */
export function isFollowable(state: unknown): boolean {
  return (state as { followable?: unknown } | undefined)?.followable !== false
}
