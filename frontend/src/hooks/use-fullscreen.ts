import { useCallback, useEffect, useState } from 'react'

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

  useEffect(() => {
    if (typeof document === 'undefined') return

    const doc = document as FullscreenDocument
    const root = document.documentElement as FullscreenElement

    const handleChange = () => {
      setIsFullscreen(!!getFullscreenElement(doc))
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
      return
    }

    if (typeof target.webkitRequestFullscreen === 'function') {
      await target.webkitRequestFullscreen()
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
