// Copies the Vite build (dist-client-mygo) into assets/web, which the Go build embeds.
import { cp, readdir, rm } from 'node:fs/promises'

const source = new URL('../dist-client-mygo/', import.meta.url)
const destination = new URL('assets/web/', import.meta.url)
for (const entry of await readdir(destination)) {
  // The placeholder keeps the embedded directory in Git.
  if (entry !== 'BUILD_REQUIRED.txt') await rm(new URL(entry, destination), { recursive: true })
}
await cp(source, destination, { recursive: true })
