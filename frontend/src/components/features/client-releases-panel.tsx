import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Download, FileUp, Pencil, Plus, Trash2, Upload, X } from 'lucide-react'
import { api } from '@/api'
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Textarea,
} from '@/components/ui'
import { translateError } from '@/i18n/errors'
import { fileNameVersion, hasUpdateFor, inferAsset, platformLabel, sortByPlatform } from '@/lib/client-releases'
import { queryKeys } from '@/lib/query-keys'
import { formatBytes, formatDateTime } from '@/lib/utils'
import { CLIENT_PLATFORMS, type ClientAssetKind, type ClientPlatform, type ClientRelease } from '@/types'

const KINDS: ClientAssetKind[] = ['installer', 'update']

/** A file picked for upload, with the .sig file of the same name when one was picked too. */
interface PendingFile {
  key: string
  file: File
  signature: File | null
  platform: ClientPlatform | ''
  kind: ClientAssetKind
}

const errorMessage = (error: unknown) => translateError(error instanceof Error ? error.message : 'Request failed')

function nextPatchVersion(version: string | undefined): string {
  const match = version?.match(/^(\d+)\.(\d+)\.(\d+)/)
  return match ? `${match[1]}.${match[2]}.${Number(match[3]) + 1}` : '0.1.0'
}

function CreateReleaseDialog({ open, onOpenChange, suggestion }: { open: boolean; onOpenChange: (open: boolean) => void; suggestion: string }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [error, setError] = useState('')
  const create = useMutation({
    mutationFn: (data: { version: string; notes: string }) => api.createClientRelease(data),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.adminClientReleases })
      onOpenChange(false)
    },
  })

  useEffect(() => {
    if (!open) setError('')
  }, [open])

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    setError('')
    create.mutate(
      { version: String(fields.get('version') ?? '').trim(), notes: String(fields.get('notes') ?? '') },
      { onError: (err) => setError(errorMessage(err)) }
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined}>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t('admin.releases.createTitle')}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2 py-2">
            <div className="space-y-1">
              <Label htmlFor="client-release-version">{t('admin.releases.version')}</Label>
              <Input id="client-release-version" name="version" placeholder={suggestion} autoComplete="off" spellCheck={false} required />
              <p className="text-xs text-muted-foreground">{t('admin.releases.versionHint', { example: suggestion })}</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="client-release-notes">{t('admin.releases.notes')}</Label>
              <Textarea id="client-release-notes" name="notes" rows={4} maxLength={10000} />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? t('admin.releases.creating') : t('admin.releases.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function NotesDialog({ release, open, onOpenChange }: { release: ClientRelease; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [error, setError] = useState('')
  const save = useMutation({
    mutationFn: (notes: string) => api.updateClientRelease(release.id, { notes }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.adminClientReleases })
      onOpenChange(false)
    },
  })

  useEffect(() => {
    if (!open) setError('')
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined}>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            setError('')
            save.mutate(String(new FormData(event.currentTarget).get('notes') ?? ''), { onError: (err) => setError(errorMessage(err)) })
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('admin.releases.notesTitle', { version: release.version })}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2 py-2">
            <Label htmlFor={`client-release-notes-${release.id}`} className="sr-only">{t('admin.releases.notes')}</Label>
            <Textarea id={`client-release-notes-${release.id}`} name="notes" rows={6} maxLength={10000} defaultValue={release.notes} />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={save.isPending}>{t('common.save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

type Confirmation = 'publish' | 'unpublish' | 'delete'

function ReleaseCard({ release }: { release: ClientRelease }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const fileInput = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState<PendingFile[]>([])
  const [strays, setStrays] = useState<string[]>([])
  const [progress, setProgress] = useState<{ name: string; fraction: number } | null>(null)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState<Confirmation | null>(null)
  const [editingNotes, setEditingNotes] = useState(false)
  const [dragging, setDragging] = useState(false)
  const isDraft = release.publishedAt === null
  const assets = sortByPlatform(release.assets)
  const titleId = `client-release-${release.id}`

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.adminClientReleases }),
      queryClient.invalidateQueries({ queryKey: queryKeys.clientDownloads }),
    ])
  const update = useMutation({
    mutationFn: (published: boolean) => api.updateClientRelease(release.id, { published }),
    onSuccess: async () => {
      setConfirm(null)
      await refresh()
    },
    onError: (err) => setError(errorMessage(err)),
  })
  const remove = useMutation({
    mutationFn: () => api.deleteClientRelease(release.id),
    onSuccess: async () => {
      setConfirm(null)
      await refresh()
    },
    onError: (err) => setError(errorMessage(err)),
  })
  const removeAsset = useMutation({
    mutationFn: (assetId: string) => api.deleteClientReleaseAsset(release.id, assetId),
    onSuccess: refresh,
    onError: (err) => setError(errorMessage(err)),
  })

  // Pairs each file with its .sig and guesses its platform and kind from the bundler's naming.
  const addFiles = (files: File[]) => {
    setError('')
    const isSignature = (file: File) => file.name.toLowerCase().endsWith('.sig')
    const signatures = new Map(files.filter(isSignature).map((file) => [file.name.slice(0, -4), file]))
    const added: PendingFile[] = files
      .filter((file) => !isSignature(file))
      .map((file) => {
        const guess = inferAsset(file.name)
        return { key: crypto.randomUUID(), file, signature: signatures.get(file.name) ?? null, platform: guess.platform ?? '', kind: guess.kind }
      })
    const next = [...pending.map((item) => ({ ...item, signature: signatures.get(item.file.name) ?? item.signature })), ...added]
    const paired = new Set(next.map((item) => item.file.name))
    setPending(next)
    setStrays([...signatures.keys()].filter((name) => !paired.has(name)).map((name) => `${name}.sig`))
  }

  const changePending = (key: string, change: Partial<PendingFile>) =>
    setPending((items) => items.map((item) => (item.key === key ? { ...item, ...change } : item)))

  const duplicate = (item: PendingFile) =>
    pending.some((other) => other !== item && other.platform === item.platform && other.kind === item.kind)
  const canUpload = pending.length > 0 && !progress && pending.every((item) => item.platform && !duplicate(item))

  const uploadAll = async () => {
    setError('')
    for (const item of pending) {
      if (!item.platform) return
      setProgress({ name: item.file.name, fraction: 0 })
      try {
        const signature = item.signature ? (await item.signature.text()).trim() : undefined
        await api.uploadClientReleaseAsset(
          release.id,
          { platform: item.platform, kind: item.kind, file: item.file, signature },
          (fraction) => setProgress({ name: item.file.name, fraction })
        )
        setPending((items) => items.filter((other) => other.key !== item.key))
      } catch (err) {
        setError(`${item.file.name}: ${errorMessage(err)}`)
        break
      } finally {
        setProgress(null)
      }
    }
    setStrays([])
    await refresh()
  }

  // Platforms whose installed clients would not update to this release.
  const platforms = CLIENT_PLATFORMS.filter((platform) => assets.some((asset) => asset.platform === platform))
  const withoutUpdates = platforms.filter((platform) => !hasUpdateFor(assets, platform))
  const hasInstaller = assets.some((asset) => asset.kind === 'installer')

  return (
    <section aria-labelledby={titleId} className="space-y-2 rounded-md border p-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <h3 id={titleId} className="text-base font-semibold">{t('admin.releases.versionLabel', { version: release.version })}</h3>
        {isDraft ? (
          <Badge variant="secondary">{t('admin.releases.draft')}</Badge>
        ) : (
          <Badge variant="success">{t('admin.releases.published', { date: formatDateTime(release.publishedAt!) })}</Badge>
        )}
        <span className="text-xs text-muted-foreground">
          {t('admin.releases.createdBy', { name: release.createdBy ?? 'CI', date: formatDateTime(release.createdAt) })}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setEditingNotes(true)}>
            <Pencil className="h-3 w-3" />
            {t('admin.releases.editNotes')}
          </Button>
          {isDraft ? (
            <>
              <Button size="sm" onClick={() => setConfirm('publish')} disabled={!hasInstaller || pending.length > 0}>
                {t('admin.releases.publish')}
              </Button>
              <Button size="sm" variant="destructive" onClick={() => setConfirm('delete')} aria-label={t('admin.releases.delete')}>
                <Trash2 className="h-3 w-3" />
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setConfirm('unpublish')}>{t('admin.releases.unpublish')}</Button>
          )}
        </div>
      </div>

      {release.notes && <p className="whitespace-pre-wrap text-sm">{release.notes}</p>}

      <div className="overflow-x-auto">
        <table className="w-full text-sm [&_th]:whitespace-nowrap">
          <thead>
            <tr className="border-b text-left">
              <th className="px-1.5 py-1 font-medium">{t('admin.releases.table.platform')}</th>
              <th className="px-1.5 py-1 font-medium">{t('admin.releases.table.kind')}</th>
              <th className="px-1.5 py-1 font-medium">{t('admin.releases.table.file')}</th>
              <th className="px-1.5 py-1 font-medium">{t('admin.releases.table.size')}</th>
              <th className="px-1.5 py-1 font-medium hidden md:table-cell">{t('admin.releases.table.sha256')}</th>
              <th className="px-1.5 py-1 font-medium">{t('admin.releases.table.update')}</th>
              <th className="px-1.5 py-1 font-medium">{t('admin.releases.table.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {assets.map((asset) => {
              // macOS installs updates from the update bundle only, never from the .dmg.
              const installerUpdates = asset.kind === 'update' || !asset.platform.startsWith('darwin-')
              return (
                <tr key={asset.id} className="border-b">
                  <td className="px-1.5 py-1 whitespace-nowrap">{platformLabel(t, asset.platform)}</td>
                  <td className="px-1.5 py-1 whitespace-nowrap">{t(`admin.releases.kinds.${asset.kind}`)}</td>
                  <td className="px-1.5 py-1 break-all">{asset.fileName}</td>
                  <td className="px-1.5 py-1 whitespace-nowrap">{formatBytes(asset.size)}</td>
                  <td className="px-1.5 py-1 hidden md:table-cell">
                    <code className="text-xs text-muted-foreground" title={asset.sha256}>{asset.sha256.slice(0, 12)}</code>
                  </td>
                  <td className="px-1.5 py-1 whitespace-nowrap">
                    {!installerUpdates ? (
                      <span className="text-muted-foreground">—</span>
                    ) : asset.signed ? (
                      <span className="text-success">{t('admin.releases.signed')}</span>
                    ) : (
                      <span className="text-muted-foreground">{t('admin.releases.unsigned')}</span>
                    )}
                  </td>
                  <td className="px-1.5 py-1">
                    {isDraft ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => removeAsset.mutate(asset.id)}
                        disabled={removeAsset.isPending}
                        aria-label={t('admin.releases.deleteFile', { name: asset.fileName })}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    ) : (
                      <Button size="sm" variant="ghost" asChild>
                        <a href={asset.downloadUrl} download={asset.fileName} aria-label={t('admin.releases.downloadFile', { name: asset.fileName })}>
                          <Download className="h-3 w-3" />
                        </a>
                      </Button>
                    )}
                  </td>
                </tr>
              )
            })}
            {assets.length === 0 && (
              <tr>
                <td className="px-1.5 py-2 text-center text-muted-foreground" colSpan={7}>{t('admin.releases.noFiles')}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {(withoutUpdates.length > 0 || (isDraft && !hasInstaller)) && (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {isDraft && !hasInstaller && (
            <li className="flex items-center gap-1"><AlertTriangle className="h-3 w-3 shrink-0" />{t('admin.releases.warnings.noInstaller')}</li>
          )}
          {withoutUpdates.map((platform) => (
            <li key={platform} className="flex items-center gap-1">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              {t(platform.startsWith('darwin-') ? 'admin.releases.warnings.noMacUpdate' : 'admin.releases.warnings.noUpdate', { platform: platformLabel(t, platform) })}
            </li>
          ))}
        </ul>
      )}

      {isDraft && (
        <div
          className={`rounded-md border border-dashed p-2 ${dragging ? 'border-primary bg-accent' : ''}`}
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            addFiles([...event.dataTransfer.files])
          }}
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()} disabled={!!progress}>
              <FileUp className="h-3 w-3" />
              {t('admin.releases.addFiles')}
            </Button>
            <span className="text-xs text-muted-foreground">{t('admin.releases.dropHint')}</span>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              accept=".exe,.msi,.dmg,.gz,.zip,.AppImage,.deb,.rpm,.sig"
              aria-label={t('admin.releases.addFiles')}
              onChange={(event) => {
                addFiles([...(event.target.files ?? [])])
                event.target.value = ''
              }}
            />
          </div>

          {pending.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {pending.map((item) => {
                const fileVersion = fileNameVersion(item.file.name)
                const replaces = assets.find((asset) => asset.platform === item.platform && asset.kind === item.kind)
                return (
                  <li key={item.key} className="flex flex-wrap items-center gap-1.5 text-sm">
                    <span className="min-w-0 flex-1 basis-56 break-all">
                      {item.file.name} <span className="text-xs text-muted-foreground">({formatBytes(item.file.size)})</span>
                      <span className="block text-xs text-muted-foreground">
                        {item.signature ? t('admin.releases.signatureMatched', { name: item.signature.name }) : t('admin.releases.noSignature')}
                        {fileVersion && fileVersion !== release.version && (
                          <span className="text-destructive"> · {t('admin.releases.versionMismatch', { fileVersion })}</span>
                        )}
                        {duplicate(item) && <span className="text-destructive"> · {t('admin.releases.duplicate')}</span>}
                        {!duplicate(item) && replaces && <span> · {t('admin.releases.replaces', { name: replaces.fileName })}</span>}
                      </span>
                    </span>
                    <Select value={item.platform} onValueChange={(platform) => changePending(item.key, { platform: platform as ClientPlatform })}>
                      <SelectTrigger className="h-control-sm w-44 text-xs" aria-label={t('admin.releases.table.platform')}>
                        <SelectValue placeholder={t('admin.releases.choosePlatform')} />
                      </SelectTrigger>
                      <SelectContent>
                        {CLIENT_PLATFORMS.map((platform) => (
                          <SelectItem key={platform} value={platform}>{platformLabel(t, platform)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={item.kind} onValueChange={(kind) => changePending(item.key, { kind: kind as ClientAssetKind })}>
                      <SelectTrigger className="h-control-sm w-28 text-xs" aria-label={t('admin.releases.table.kind')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {KINDS.map((kind) => (
                          <SelectItem key={kind} value={kind}>{t(`admin.releases.kinds.${kind}`)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => setPending((items) => items.filter((other) => other.key !== item.key))}
                      disabled={!!progress}
                      aria-label={t('admin.releases.remove', { name: item.file.name })}
                    >
                      <X />
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
          {strays.length > 0 && (
            <p className="mt-1 text-xs text-destructive">{t('admin.releases.straySignatures', { names: strays.join(', ') })}</p>
          )}
          {pending.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Button size="sm" onClick={() => void uploadAll()} disabled={!canUpload}>
                <Upload className="h-3 w-3" />
                {t('admin.releases.upload')}
              </Button>
              {progress && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground" aria-live="polite">
                  <Spinner size="sm" />
                  {t('admin.releases.uploading', { name: progress.name, percent: Math.round(progress.fraction * 100) })}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <NotesDialog release={release} open={editingNotes} onOpenChange={setEditingNotes} />
      <Dialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm && t(`admin.releases.${confirm}Title`, { version: release.version })}
            </DialogTitle>
            <DialogDescription>{confirm && t(`admin.releases.${confirm}Confirm`)}</DialogDescription>
          </DialogHeader>
          {confirm === 'publish' && withoutUpdates.length > 0 && (
            <ul className="space-y-0.5 text-xs text-muted-foreground">
              {withoutUpdates.map((platform) => (
                <li key={platform} className="flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3 shrink-0" />
                  {t(platform.startsWith('darwin-') ? 'admin.releases.warnings.noMacUpdate' : 'admin.releases.warnings.noUpdate', { platform: platformLabel(t, platform) })}
                </li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>{t('common.cancel')}</Button>
            {confirm === 'delete' ? (
              <Button variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>{t('common.delete')}</Button>
            ) : (
              <Button onClick={() => update.mutate(confirm === 'publish')} disabled={update.isPending}>
                {confirm === 'unpublish' ? t('admin.releases.unpublish') : t('admin.releases.publish')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

/** Admin: desktop client versions, their files per platform, and publishing. */
export function ClientReleasesPanel() {
  const { t } = useTranslation()
  const [creating, setCreating] = useState(false)
  const releases = useQuery({ queryKey: queryKeys.adminClientReleases, queryFn: () => api.listClientReleases() })
  const list = releases.data?.releases ?? []

  return (
    <Card>
      <CardContent className="space-y-2 px-1.5 pt-2 sm:px-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="max-w-3xl text-sm text-muted-foreground">{t('admin.releases.description')}</p>
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            {t('admin.releases.create')}
          </Button>
        </div>
        {releases.isLoading ? (
          <div className="flex justify-center py-3"><Spinner /></div>
        ) : releases.error ? (
          <p className="text-sm text-destructive">{errorMessage(releases.error)}</p>
        ) : list.length === 0 ? (
          <p className="py-3 text-center text-sm text-muted-foreground">{t('admin.releases.empty')}</p>
        ) : (
          list.map((release) => <ReleaseCard key={release.id} release={release} />)
        )}
      </CardContent>
      <CreateReleaseDialog open={creating} onOpenChange={setCreating} suggestion={nextPatchVersion(list[0]?.version)} />
    </Card>
  )
}
