// Stands in for components/features/share-link-manager in the client build (vite.client.config.ts).
// Customers join as guests and guests never manage share links (canManageRoom is false),
// so the room renders exactly as on the web while the owner's share manager stays out.
export function ShareLinkManager(_props: { roomId: string; guestName?: string; showDescription?: boolean }) {
  return null
}
