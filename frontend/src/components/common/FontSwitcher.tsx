import { Minus, Plus, Type } from 'lucide-react'
import { useFont, type EditorFont } from '../../contexts/FontContext'
import { useTranslation } from 'react-i18next'

const FONTS: Array<{ value: EditorFont; label: string }> = [
    { value: 'JetBrains Mono', label: 'JetBrains Mono' },
    { value: 'Julia Mono', label: 'Julia Mono' },
]

export function FontSwitcher() {
    const { font, setFont, fontSize, setFontSize } = useFont()
    const { t } = useTranslation()

    return (
        <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 bg-[var(--bg-hover)] rounded-md border border-[var(--border)] p-0.5">
                <button
                    onClick={() => setFontSize(fontSize - 1)}
                    disabled={fontSize <= 8}
                    className="p-0 flex items-center justify-center h-7 w-7 hover:bg-[var(--bg-card)] rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50 disabled:cursor-not-allowed"
                    title={t('editor.font.decreaseSize') || 'Decrease font size'}
                >
                    <Minus size={14} />
                </button>
                <span className="text-xs font-mono min-w-[20px] text-center select-none">
                    {fontSize}
                </span>
                <button
                    onClick={() => setFontSize(fontSize + 1)}
                    disabled={fontSize >= 32}
                    className="p-0 flex items-center justify-center h-7 w-7 hover:bg-[var(--bg-card)] rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50 disabled:cursor-not-allowed"
                    title={t('editor.font.increaseSize') || 'Increase font size'}
                >
                    <Plus size={14} />
                </button>
            </div>

            <div className="relative flex items-center group">
                <Type size={14} className="absolute left-2 text-[var(--text-secondary)] pointer-events-none" />
                <select
                    value={font}
                    onChange={(e) => setFont(e.target.value as EditorFont)}
                    className="toolbar-select pl-7 appearance-none bg-[var(--bg-hover)] border-[var(--border)] hover:border-[var(--accent)] focus:border-[var(--accent)]"
                    title={t('editor.font.selectFont') || 'Select editor font'}
                    style={{ paddingLeft: '28px' }}
                >
                    {FONTS.map((f) => (
                        <option key={f.value} value={f.value}>
                            {f.label}
                        </option>
                    ))}
                </select>
            </div>
        </div>
    )
}
