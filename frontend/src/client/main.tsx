import { createRoot } from 'react-dom/client'
import { ClientApp } from './app'
import '@/styles/globals.css'
import './client.css'
import '@/i18n'

createRoot(document.getElementById('root')!).render(<ClientApp />)
