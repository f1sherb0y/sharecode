import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import en from './locales/en.json'
import zh from './locales/zh.json'

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      zh: { translation: zh },
    },
    fallbackLng: 'en',
    supportedLngs: ['en', 'zh'],
    nonExplicitSupportedLngs: true,
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
    },
    interpolation: {
      escapeValue: false,
    },
  })

// Keep browser accessibility and native form controls in the selected language.
function updateDocumentLanguage() {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = i18n.resolvedLanguage === 'zh' ? 'zh-CN' : 'en'
  }
}
i18n.on('languageChanged', updateDocumentLanguage)
updateDocumentLanguage()

export function getLocale() {
  return i18n.resolvedLanguage === 'zh' ? 'zh-CN' : 'en-US'
}

export default i18n
