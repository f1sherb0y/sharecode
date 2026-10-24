import { ShareCodeLogo } from '../share-code-logo'

export function AuthBrand() {
  return (
    <div className="flex items-center gap-2 px-2 pb-3">
      <ShareCodeLogo className="h-10 w-10 shrink-0" />
      <span className="text-[1.625rem] font-semibold leading-none">ShareCode</span>
    </div>
  )
}
