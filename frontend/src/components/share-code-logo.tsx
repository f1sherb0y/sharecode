import type { SVGProps } from 'react'

/** ShareCode's compact brand mark: three connected nodes inside a soft, app-icon shape. */
export function ShareCodeLogo({ title, ...props }: SVGProps<SVGSVGElement> & { title?: string }) {
  const labelled = Boolean(title)
  return (
    <svg
      viewBox="0 0 40 40"
      fill="none"
      role={labelled ? 'img' : undefined}
      aria-hidden={labelled ? undefined : true}
      {...props}
    >
      {labelled && <title>{title}</title>}
      <defs>
        <linearGradient id="sharecode-logo-gradient" x1="5" y1="4" x2="35" y2="36" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6D5DFB" />
          <stop offset="1" stopColor="#19B7B0" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="38" height="38" rx="12" fill="url(#sharecode-logo-gradient)" />
      <path d="M11.5 12.5 20 17.4m0 5.2-8.5 4.9m8.5-10.1 8.5-4.9m-8.5 10.1 8.5 4.9" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" opacity="0.92" />
      <circle cx="11.5" cy="12.5" r="3.5" fill="white" />
      <circle cx="28.5" cy="12.5" r="3.5" fill="white" />
      <circle cx="20" cy="20" r="4.25" fill="white" />
      <circle cx="11.5" cy="27.5" r="3.5" fill="white" />
      <circle cx="28.5" cy="27.5" r="3.5" fill="white" />
      <circle cx="20" cy="20" r="1.7" fill="#5C62E8" />
    </svg>
  )
}
