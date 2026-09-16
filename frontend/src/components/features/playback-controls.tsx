import { useTranslation } from 'react-i18next'
import { Play, Pause, SkipBack, SkipForward } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useCompactViewport } from '@/hooks/use-compact-viewport'
import { cn } from '@/lib/utils'

export function PlaybackControls({ startMs, endMs, currentTimestamp, playbackSpeed, isPlaying, updates, timeLabel, onSeek, onPlayingChange, onSpeedChange }: {
  startMs: number; endMs: number; currentTimestamp: number; playbackSpeed: number; isPlaying: boolean
  updates: readonly { timestampMs: number }[]; timeLabel: string
  onSeek: (value: number) => void; onPlayingChange: (value: boolean) => void; onSpeedChange: (value: number) => void
}) {
  const { t } = useTranslation()
  const isCompactViewport = useCompactViewport()
  return (
      <footer
        className={cn(
          'safe-bottom border-t bg-background shrink-0',
          'px-2 py-1'
        )}
      >
        {/* Timeline with marks */}
        <div className="relative mb-1">
          <input
            type="range"
            aria-label={t('playback.progress')}
            min={startMs}
            max={endMs}
            step="any"
            value={currentTimestamp}
            onChange={(e) => {
              onSeek(Number(e.target.value))
              onPlayingChange(false)
            }}
            className={cn(
              'w-full bg-secondary rounded-lg appearance-none cursor-pointer relative z-10',
              isCompactViewport ? 'h-1.5' : 'h-2'
            )}
          />
          {/* Update marks - group close updates into regions */}
          <div className={cn('absolute top-0 left-0 right-0 pointer-events-none', isCompactViewport ? 'h-1.5' : 'h-2')}>
            {(() => {
              const duration = endMs - startMs
              if (duration === 0) return null

              const regions: { start: number; end: number }[] = []
              const threshold = 0.5 // 0.5% threshold for grouping

              updates.forEach((update) => {
                const pos = ((update.timestampMs - startMs) / duration) * 100
                const lastRegion = regions[regions.length - 1]

                if (lastRegion && pos - lastRegion.end < threshold) {
                  // Extend existing region
                  lastRegion.end = pos
                } else {
                  // Start new region
                  regions.push({ start: pos, end: pos })
                }
              })

              return regions.map((region, i) => {
                const width = Math.max(region.end - region.start, 0.3) // Min width for visibility
                return (
                  <div
                    key={i}
                    className={cn('absolute top-0 bg-primary/50 rounded-sm', isCompactViewport ? 'h-1.5' : 'h-2')}
                    style={{
                      left: `${region.start}%`,
                      width: `${width}%`,
                    }}
                  />
                )
              })
            })()}
          </div>
        </div>

        {/* Controls */}
        <div className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1 sm:grid-cols-[auto_1fr_auto]">
          <div className="order-1 flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              aria-label={t('playback.goToStart')}
              onClick={() => {
                onSeek(startMs)
                onPlayingChange(false)
              }}
            >
              <SkipBack className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label={t(isPlaying ? 'playback.pause' : 'playback.play')}
              onClick={() => onPlayingChange(!isPlaying)}
            >
              {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label={t('playback.goToEnd')}
              onClick={() => {
                onSeek(endMs)
                onPlayingChange(false)
              }}
            >
              <SkipForward className="h-4 w-4" />
            </Button>
          </div>
          <span className="order-3 col-span-2 text-center text-xs text-muted-foreground font-mono tabular-nums sm:order-2 sm:col-span-1 sm:text-left">
            {timeLabel}
          </span>

          <div className="order-2 flex items-center gap-1 sm:order-3">
            {!isCompactViewport && <span className="text-sm text-muted-foreground">{t('playback.speed')}:</span>}
            <Select
              value={String(playbackSpeed)}
              onValueChange={(v) => {
                onSpeedChange(Number(v))
              }}
            >
              <SelectTrigger aria-label={t('playback.speed')} className="w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0.5">0.5x</SelectItem>
                <SelectItem value="1">1x</SelectItem>
                <SelectItem value="2">2x</SelectItem>
                <SelectItem value="5">5x</SelectItem>
                <SelectItem value="10">10x</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </footer>
  )
}
