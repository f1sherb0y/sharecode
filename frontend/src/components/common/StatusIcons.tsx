import { CheckCircle2, Loader2, Wifi, WifiOff } from 'lucide-react'

export function ConnectedIcon() {
    return <Wifi size={18} strokeWidth={2.25} />
}

export function DisconnectedIcon() {
    return <WifiOff size={18} strokeWidth={2.25} />
}

export function SyncedIcon() {
    return <CheckCircle2 size={18} strokeWidth={2.25} />
}

export function SyncingIcon() {
    return <Loader2 size={18} strokeWidth={2.25} className="icon-spin" />
}
