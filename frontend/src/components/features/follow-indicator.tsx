import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { FollowStatus } from '@/lib/follow'

/** One follow frame for code, Markdown and Canvas, so stopping works the same in every view. */
export function FollowIndicator({ status, name, onStop }: { status: FollowStatus; name: string; onStop: () => void }) {
  const { t } = useTranslation()
  // Above Excalidraw's toolbars, below its modals (z-index 1000).
  return <div data-follow-status={status} className={`follow-indicator pointer-events-none absolute inset-0 z-[999] flex items-end justify-center border-2 ${status === 'active' ? 'border-primary' : 'border-dashed border-muted-foreground/60'}`}>
    <div role="status" className="pointer-events-auto mb-2 flex max-w-[calc(100%-1rem)] items-center gap-1 rounded-md bg-primary py-0.5 pl-2 pr-0.5 text-xs text-primary-foreground shadow-sm">
      <span className="truncate">{t(`editor.follow.${status}`, { name })}</span>
      <Button variant="ghost" size="icon-sm" aria-label={t('editor.follow.stop')} title={t('editor.follow.stop')} className="hover:bg-primary-foreground/15 hover:text-primary-foreground" onClick={onStop}><X /></Button>
    </div>
  </div>
}
