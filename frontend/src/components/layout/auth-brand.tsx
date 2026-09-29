import { Code2 } from 'lucide-react'

export function AuthBrand() {
  return (
    <div className="flex items-center gap-2 px-2 pb-3">
      <Code2 className="h-10 w-10 shrink-0 text-foreground" aria-hidden="true" />
      <span className="text-[1.625rem] font-semibold leading-none">ShareCode</span>
    </div>
  )
}
