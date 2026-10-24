import type { ImgHTMLAttributes } from 'react'
import logoUrl from '@/assets/sharecode-logo.svg'

/** ShareCode's mark, the same file the favicons and the desktop apps' icons come from. */
export function ShareCodeLogo({ title, ...props }: ImgHTMLAttributes<HTMLImageElement> & { title?: string }) {
  return <img src={logoUrl} alt={title ?? ''} aria-hidden={title ? undefined : true} draggable={false} {...props} />
}
