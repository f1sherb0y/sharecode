import { cn } from '@/lib/utils'

interface PageContainerProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode
  fullWidth?: boolean
}

export function PageContainer({ children, className, fullWidth = false, ...props }: PageContainerProps) {
  return (
    <main className={cn('flex-1', className)} {...props}>
      <div className={cn('py-4 px-4', !fullWidth && 'container')}>
        {children}
      </div>
    </main>
  )
}
