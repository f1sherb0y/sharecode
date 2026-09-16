import { useEffect, useState } from 'react'

/** The visual viewport also shrinks for Safari's on-screen keyboard. */
export function useViewportHeight() {
  const [height, setHeight] = useState<number>()

  useEffect(() => {
    const viewport = window.visualViewport
    const update = () => {
      // Keep pinch zoom native; do not reflow the editor during magnification.
      if (!viewport || Math.abs(viewport.scale - 1) < 0.01) {
        setHeight(viewport?.height ?? window.innerHeight)
      }
    }
    update()
    viewport?.addEventListener('resize', update)
    window.addEventListener('resize', update)
    return () => {
      viewport?.removeEventListener('resize', update)
      window.removeEventListener('resize', update)
    }
  }, [])

  return height === undefined ? '100dvh' : `${height}px`
}
