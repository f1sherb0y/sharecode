import { Minus, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui'
import { useFontStore } from '@/stores'

/** Local reading preferences; changing them never changes the shared document. */
export function FontControls() {
  const { t } = useTranslation()
  const { fontSize, decreaseFontSize, increaseFontSize } = useFontStore()

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Button variant="ghost" size="icon-sm" onClick={decreaseFontSize} disabled={fontSize <= 10} aria-label={t('editor.font.decreaseSize')} title={t('editor.font.decreaseSize')}>
        <Minus />
      </Button>
      <span className="w-5 text-center text-xs tabular-nums" aria-label={t('editor.font.size')}>{fontSize}</span>
      <Button variant="ghost" size="icon-sm" onClick={increaseFontSize} disabled={fontSize >= 24} aria-label={t('editor.font.increaseSize')} title={t('editor.font.increaseSize')}>
        <Plus />
      </Button>
    </div>
  )
}
