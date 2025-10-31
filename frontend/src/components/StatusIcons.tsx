export function ConnectedIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="7" fill="currentColor" opacity="0.2" />
            <circle cx="8" cy="8" r="4" fill="currentColor" />
            <path
                d="M5 8l2 2 4-4"
                stroke="white"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    )
}

export function DisconnectedIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="7" fill="currentColor" opacity="0.2" />
            <circle cx="8" cy="8" r="4" fill="currentColor" />
            <path
                d="M6 6l4 4M10 6l-4 4"
                stroke="white"
                strokeWidth="1.5"
                strokeLinecap="round"
            />
        </svg>
    )
}

export function SyncedIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
                d="M13 5l-8 8-4-4"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    )
}

export function SyncingIcon() {
    return (
        <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            className="spinner"
            style={{ borderWidth: '2px' }}
        >
            <circle
                cx="8"
                cy="8"
                r="6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray="32"
                strokeDashoffset="8"
                fill="none"
            >
                <animateTransform
                    attributeName="transform"
                    type="rotate"
                    from="0 8 8"
                    to="360 8 8"
                    dur="1s"
                    repeatCount="indefinite"
                />
            </circle>
        </svg>
    )
}
