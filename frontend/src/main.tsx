import { createRoot } from 'react-dom/client'
import App from './App'
import { setDrawSampleIntervalMs } from '@/lib/tldraw-config'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/400-italic.css'
import '@fontsource/jetbrains-mono/700.css'
import '@/styles/globals.css'
import '@/i18n'

setDrawSampleIntervalMs(200) // 5 Hz cap on mouse draw samples

createRoot(document.getElementById('root')!).render(<App />)
