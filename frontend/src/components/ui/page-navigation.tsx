import { useTranslation } from 'react-i18next'
import { Button } from './button'
import type { PaginationMeta } from '@/types'
export function PageNavigation({ pagination: p, disabled, onPage }: { pagination: PaginationMeta; disabled?: boolean; onPage: (page: number) => void }) {
  const { t } = useTranslation()
  const pages = Array.from(new Set([1, ...Array.from({ length: 5 }, (_, i) => p.page - 2 + i), p.totalPages])).filter(n => n >= 1 && n <= p.totalPages).sort((a,b) => a-b)
  return <nav aria-label={t('admin.pagination.label')} className="mt-2 flex flex-wrap items-center justify-between gap-1 text-xs">
    <span className="text-muted-foreground">{t('admin.pagination.total', { count: p.total })}</span>
    <div className="flex flex-wrap items-center gap-1">
      <Button size="sm" variant="outline" disabled={disabled || !p.hasPrev} onClick={() => onPage(p.page - 1)}>{t('rooms.pagination.prev')}</Button>
      {pages.map((n,i) => <span key={n} className="flex items-center gap-1">
        {i > 0 && n - (pages[i-1] ?? n) > 1 && <span aria-hidden>…</span>}
        <Button size="sm" variant={n === p.page ? 'secondary' : 'ghost'} aria-current={n === p.page ? 'page' : undefined} disabled={disabled} onClick={() => onPage(n)}>{n}</Button>
      </span>)}
      <Button size="sm" variant="outline" disabled={disabled || !p.hasNext} onClick={() => onPage(p.page + 1)}>{t('rooms.pagination.next')}</Button>
    </div>
  </nav>
}
