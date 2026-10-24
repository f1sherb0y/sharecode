// Every logo file comes from src/assets/sharecode-logo.svg: the site's favicons and the icons the
// staff app and the customer client share (src-tauri/icons). Run after changing the logo:
//   node scripts/generate-icons.mjs
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

const root = join(import.meta.dirname, '..')
const logo = readFileSync(join(root, 'src/assets/sharecode-logo.svg'), 'utf8')
const publicDir = join(root, 'public')
const iconsDir = join(root, 'src-tauri/icons')
const work = mkdtempSync(join(tmpdir(), 'sharecode-icons-'))

/** Rasterises the 64-unit SVG straight at the size, from vectors. */
const render = (svg, size) => sharp(Buffer.from(svg), { density: (72 * size) / 64 }).resize(size, size).png().toBuffer()

/** iOS masks the touch icon itself and fills transparent corners black: give it the tile's full square. */
function square(svg) {
  const result = svg.replace(/<path id="tile" d="[^"]*"/, '<path id="tile" d="M0 0H64V64H0Z"').replace(/<path id="rim"[^>]*\/>/, '')
  if (result === svg || result.includes('id="rim"')) throw new Error('sharecode-logo.svg lost its tile or rim path')
  return result
}

/** macOS draws app icons on Apple's grid: the shape 824 of 1024 px with a soft drop shadow. */
async function macCanvas() {
  const body = await render(logo, 824)
  const silhouette = await sharp({ create: { width: 824, height: 824, channels: 3, background: '#000' } })
    .joinChannel(await sharp(body).extractChannel('alpha').linear(0.3, 0).toBuffer())
    .png()
    .toBuffer()
  const shadow = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#0000' } })
    .composite([{ input: silhouette, left: 100, top: 110 }])
    .png()
    .toBuffer()
  return sharp(await sharp(shadow).blur(10).toBuffer()).composite([{ input: body, left: 100, top: 100 }]).png().toBuffer()
}

/** The Tauri CLI's icon set (real .ico and .icns) from a 1024 px source. */
function tauriIcons(png, name) {
  const source = join(work, `${name}.png`)
  writeFileSync(source, png)
  const out = join(work, name)
  const tauri = join(root, 'node_modules/.bin/tauri')
  const run = spawnSync(tauri, ['icon', source, '--output', out], { stdio: 'inherit' })
  if (run.status !== 0) throw new Error(`tauri icon failed (${run.status})`)
  return out
}

try {
  writeFileSync(join(publicDir, 'favicon.svg'), logo)
  for (const [name, size] of [['favicon-16x16.png', 16], ['favicon-32x32.png', 32], ['android-chrome-192x192.png', 192], ['android-chrome-512x512.png', 512]]) {
    writeFileSync(join(publicDir, name), await render(logo, size))
  }
  writeFileSync(join(publicDir, 'apple-touch-icon.png'), await render(square(logo), 180))

  // Windows, Linux and the PNGs: the tile edge to edge. macOS: the .icns on Apple's grid.
  const full = tauriIcons(await render(logo, 1024), 'full')
  const mac = tauriIcons(await macCanvas(), 'mac')
  for (const name of readdirSync(iconsDir)) {
    const from = join(name === 'icon.icns' ? mac : full, name)
    if (!existsSync(from)) throw new Error(`tauri icon made no ${name}`)
    copyFileSync(from, join(iconsDir, name))
  }
  console.log(`Updated public/ favicons and ${readdirSync(iconsDir).length} files in src-tauri/icons`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
