import { useCallback, useEffect, useRef, useState } from 'react'

type FullscreenDocument = Document & {
  webkitExitFullscreen?: () => Promise<void> | void
  webkitFullscreenElement?: Element | null
  webkitFullscreenEnabled?: boolean
}

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void
}

function getFullscreenElement(doc: FullscreenDocument) {
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null
}

function canFullscreenElement(el: FullscreenElement | null) {
  return !!el && (typeof el.requestFullscreen === 'function' || typeof el.webkitRequestFullscreen === 'function')
}

export function useFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [isSupported, setIsSupported] = useState(false)
  const requestedElement = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (typeof document === 'undefined') return

    const doc = document as FullscreenDocument
    const root = document.documentElement as FullscreenElement

    const handleChange = () => {
      const activeElement = getFullscreenElement(doc)
      setIsFullscreen(!!activeElement)
      if (activeElement !== requestedElement.current) requestedElement.current = null
    }

    setIsSupported(
      !!(doc.fullscreenEnabled || doc.webkitFullscreenEnabled || canFullscreenElement(root) || typeof doc.webkitExitFullscreen === 'function')
    )
    handleChange()

    document.addEventListener('fullscreenchange', handleChange)
    document.addEventListener('webkitfullscreenchange', handleChange as EventListener)

    return () => {
      document.removeEventListener('fullscreenchange', handleChange)
      document.removeEventListener('webkitfullscreenchange', handleChange as EventListener)
    }
  }, [])

  const enterFullscreen = useCallback(async (element: HTMLElement | null) => {
    if (!element) return

    const target = element as FullscreenElement

    if (typeof target.requestFullscreen === 'function') {
      await target.requestFullscreen()
      requestedElement.current = element
      return
    }

    if (typeof target.webkitRequestFullscreen === 'function') {
      await target.webkitRequestFullscreen()
      requestedElement.current = element
    }
  }, [])

  const exitFullscreen = useCallback(async () => {
    if (typeof document === 'undefined') return

    const doc = document as FullscreenDocument

    if (typeof document.exitFullscreen === 'function') {
      await document.exitFullscreen()
      return
    }

    if (typeof doc.webkitExitFullscreen === 'function') {
      await doc.webkitExitFullscreen()
    }
  }, [])

  // Fullscreen now includes the document and its portals. Leaving the editor
  // must still exit the fullscreen session that this hook started.
  useEffect(() => () => {
    if (requestedElement.current && getFullscreenElement(document as FullscreenDocument) === requestedElement.current) {
      void exitFullscreen().catch(() => {})
    }
  }, [exitFullscreen])

  const toggleFullscreen = useCallback(async (element: HTMLElement | null) => {
    const doc = document as FullscreenDocument

    if (getFullscreenElement(doc)) {
      await exitFullscreen()
      return
    }

    await enterFullscreen(element)
  }, [enterFullscreen, exitFullscreen])

  return {
    isFullscreen,
    isSupported,
    enterFullscreen,
    exitFullscreen,
    toggleFullscreen,
  }
}
