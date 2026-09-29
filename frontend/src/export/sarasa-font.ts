import { EDITOR_FONT, SARASA_CDN_BASE } from '@/lib/editor-font'

let pending: Promise<void> | undefined
// Keep the 97 unicode-range declarations out of downloaded replay HTML. Only
// this standalone player fetches the pinned font stylesheet from the CDN.
export function registerSarasaFonts() {
  return pending ??= fetch(`${SARASA_CDN_BASE}SarasaMonoCL-Regular.css`, { cache: 'force-cache', referrerPolicy: 'no-referrer' })
    .then(async response => {
      if (!response.ok) throw new Error('Could not load Sarasa Mono font declarations')
      const css = (await response.text())
        .replace(/font-family: SarasaMonoCL-Regular/g, `font-family: "${EDITOR_FONT}"`)
        .replace(/url\('([^']+)'\)/g, (_, file: string) => `url("${new URL(file, SARASA_CDN_BASE).href}")`)
      const style = document.createElement('style')
      style.textContent = css
      document.head.append(style)
    }).catch(error => { pending = undefined; throw error })
}
