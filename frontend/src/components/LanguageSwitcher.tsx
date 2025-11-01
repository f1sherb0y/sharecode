import { Globe } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import './LanguageSwitcher.css'

export function LanguageSwitcher() {
    const { i18n, t } = useTranslation()

    const toggleLanguage = () => {
        const newLang = i18n.language.startsWith('zh') ? 'en' : 'zh'
        i18n.changeLanguage(newLang)
    }

    const currentLang = i18n.language.startsWith('zh') ? '中文' : 'EN'

    return (
        <button
            onClick={toggleLanguage}
            className="language-switcher"
            title={i18n.language.startsWith('zh') ? 'Switch to English' : '切换到中文'}
        >
            <Globe size={16} />
            <span>{currentLang}</span>
        </button>
    )
}
