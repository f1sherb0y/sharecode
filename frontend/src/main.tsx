import { createRoot } from 'react-dom/client'
import App from './App'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/400-italic.css'
import '@fontsource/jetbrains-mono/700.css'
import '@/styles/globals.css'
import '@/i18n'

createRoot(document.getElementById('root')!).render(<App />)
