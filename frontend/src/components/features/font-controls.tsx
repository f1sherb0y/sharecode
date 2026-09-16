import { Check, Minus, Plus, Type } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui'
import { useFontStore } from '@/stores'
import { SELECTABLE_FONTS } from '@/stores/font'

/** Local reading preferences; changing them never changes the shared document. */
export function FontControls() {
  const { t } = useTranslation()
  const { font, fontSize, setFont, decreaseFontSize, increaseFontSize } = useFontStore()

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t('editor.font.family')} title={t('editor.font.family')}>
            <Type />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {SELECTABLE_FONTS.map((name) => (
            <DropdownMenuItem key={name} onClick={() => setFont(name)}>
              <span className="flex-1">{name}</span>
              {font === name && <Check className="ml-2 h-3.5 w-3.5" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="ghost" size="icon-sm" onClick={decreaseFontSize} disabled={fontSize <= 10} aria-label={t('editor.font.decreaseSize')} title={t('editor.font.decreaseSize')}>
        <Minus />
      </Button>
      <span className="w-5 text-center text-[11px] tabular-nums" aria-label={t('editor.font.size')}>{fontSize}</span>
      <Button variant="ghost" size="icon-sm" onClick={increaseFontSize} disabled={fontSize >= 24} aria-label={t('editor.font.increaseSize')} title={t('editor.font.increaseSize')}>
        <Plus />
      </Button>
    </div>
  )
}
