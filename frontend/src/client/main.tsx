import { createRoot } from 'react-dom/client'
import { ClientApp } from './app'
import { absorbNativeChords } from './hotkey'
import '@/styles/globals.css'
import './client.css'
import '@/i18n'

absorbNativeChords()
createRoot(document.getElementById('root')!).render(<ClientApp />)
