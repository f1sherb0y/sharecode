import { useFont, type EditorFont } from '../contexts/FontContext'

const FONTS: Array<{ value: EditorFont; label: string }> = [
    { value: 'JetBrains Mono', label: 'JetBrains Mono' },
    { value: 'Julia Mono', label: 'Julia Mono' },
]

export function FontSwitcher() {
    const { font, setFont } = useFont()

    return (
        <select
            value={font}
            onChange={(e) => setFont(e.target.value as EditorFont)}
            className="toolbar-select"
            title="Select editor font"
        >
            {FONTS.map((f) => (
                <option key={f.value} value={f.value}>
                    {f.label}
                </option>
            ))}
        </select>
    )
}
