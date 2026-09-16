import { Code2, PencilRuler } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui'

export function RoomViewSwitch({ value, onChange }: { value: 'editor' | 'canvas'; onChange: (value: 'editor' | 'canvas') => void }) {
  const { t } = useTranslation()
  return <div role="group" aria-label={t('canvas.switchView')} className="flex shrink-0 items-center gap-0.5">
    {(['editor', 'canvas'] as const).map(view => <Button key={view} size="sm" variant={view === value ? 'secondary' : 'ghost'} aria-label={t(`canvas.${view}`)} aria-pressed={view === value} onClick={() => onChange(view)}>
      {view === 'editor' ? <Code2 className="h-3.5 w-3.5" /> : <PencilRuler className="h-3.5 w-3.5" />}
      <span className="hidden sm:inline">{t(`canvas.${view}`)}</span>
    </Button>)}
  </div>
}
