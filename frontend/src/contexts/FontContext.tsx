import React, { createContext, useState, useContext } from 'react'

export type EditorFont = 'JetBrains Mono' | 'Julia Mono'

interface FontContextType {
    font: EditorFont
    fontSize: number
    setFont: (font: EditorFont) => void
    setFontSize: (size: number) => void
}

const FontContext = createContext<FontContextType | undefined>(undefined)

export const FontProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [font, setFontState] = useState<EditorFont>(() => {
        const savedFont = localStorage.getItem('editor-font')
        return (savedFont as EditorFont) || 'Julia Mono'
    })

    const [fontSize, setFontSizeState] = useState<number>(() => {
        const savedSize = localStorage.getItem('editor-font-size')
        return savedSize ? parseInt(savedSize, 10) : 14
    })

    const setFont = (newFont: EditorFont) => {
        setFontState(newFont)
        localStorage.setItem('editor-font', newFont)
    }

    const setFontSize = (newSize: number) => {
        const size = Math.max(8, Math.min(32, newSize)) // Clamp between 8 and 32
        setFontSizeState(size)
        localStorage.setItem('editor-font-size', String(size))
    }

    return (
        <FontContext.Provider value={{ font, fontSize, setFont, setFontSize }}>
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
