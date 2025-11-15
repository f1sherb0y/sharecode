import React, { createContext, useState, useContext } from 'react'

export type EditorFont = 'JetBrains Mono' | 'Julia Mono'

interface FontContextType {
    font: EditorFont
    setFont: (font: EditorFont) => void
}

const FontContext = createContext<FontContextType | undefined>(undefined)

export const FontProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [font, setFontState] = useState<EditorFont>(() => {
        const savedFont = localStorage.getItem('editor-font')
        return (savedFont as EditorFont) || 'Julia Mono'
    })

    const setFont = (newFont: EditorFont) => {
        setFontState(newFont)
        localStorage.setItem('editor-font', newFont)
    }

    return (
        <FontContext.Provider value={{ font, setFont }}>
            {children}
        </FontContext.Provider>
    )
}

export const useFont = () => {
    const context = useContext(FontContext)
    if (context === undefined) {
        throw new Error('useFont must be used within a FontProvider')
    }
    return context
}
