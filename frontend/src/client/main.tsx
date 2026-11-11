import { createRoot } from 'react-dom/client'
import { ClientApp } from './app'
import { absorbNativeChords } from './hotkey'
import { initializeMyGoClient } from './host'
import '@/styles/globals.css'
import './client.css'
import '@/i18n'

const stopMyGo = initializeMyGoClient()
if (import.meta.hot) import.meta.hot.dispose(stopMyGo)
absorbNativeChords()
createRoot(document.getElementById('root')!).render(<ClientApp />)
