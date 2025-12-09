import { createRoot } from 'react-dom/client'
import App from './App'
import '@/styles/globals.css'
import '@/i18n'

createRoot(document.getElementById('root')!).render(<App />)
