import { useEffect, useState } from 'react'

const DEFAULT_QUERY = '(pointer: coarse) and (orientation: landscape) and (max-height: 500px)'

export function useCompactViewport(query = DEFAULT_QUERY) {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined') return

    const mediaQuery = window.matchMedia(query)
    const updateMatches = () => setMatches(mediaQuery.matches)

    updateMatches()

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', updateMatches)
      return () => mediaQuery.removeEventListener('change', updateMatches)
    }

    mediaQuery.addListener(updateMatches)
    return () => mediaQuery.removeListener(updateMatches)
  }, [query])

  return matches
}
