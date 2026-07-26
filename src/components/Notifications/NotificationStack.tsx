/**
 * NotificationStack — toast notifications matching SVG radical concept.
 *
 * SVG Toast Layout:
 *   - Dark glass card with green border
 *   - Left: avatar circle with initials
 *   - Center: message + detail
 *   - Right: "diff ↗" action link
 *   - Positioned floating above cockpit pill
 *
 * Wires to: notifications, dismissNotification
 */

import { useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useAppStore } from '../../store/appStore'
import type { Notification } from '../../lib/types'
// timeAgo available from utils if needed for timestamps

const NOTIFICATION_COLORS: Record<string, { border: string; icon: string; avatarBg: string }> = {
  change:     { border: 'rgba(0,255,136,0.45)',  icon: '#00FF88', avatarBg: 'rgba(0,255,136,0.1)' },
  conflict:   { border: 'rgba(255,165,0,0.45)',  icon: '#FFA500', avatarBg: 'rgba(255,165,0,0.1)' },
  peer_join:  { border: 'rgba(0,255,136,0.45)',  icon: '#00FF88', avatarBg: 'rgba(0,255,136,0.1)' },
  peer_leave: { border: 'rgba(100,116,139,0.3)', icon: '#64748B', avatarBg: 'rgba(100,116,139,0.1)' },
  error:      { border: 'rgba(255,69,58,0.45)',  icon: '#FF453A', avatarBg: 'rgba(255,69,58,0.1)' },
}

export function NotificationStack() {
  const { notifications, dismissNotification } = useAppStore()

  const toasts = notifications.filter((n) => !n.read).slice(0, 3)

  useEffect(() => {
    if (toasts.length === 0) return
    const timer = setTimeout(() => {
      dismissNotification(toasts[toasts.length - 1].id)
    }, 6000)
    return () => clearTimeout(timer)
  }, [toasts, dismissNotification])

  return (
    <div className="fixed z-[60] flex flex-col gap-2"
      style={{
        bottom: '56px',
        left: 'calc(50% - 280px)',
        maxWidth: '240px',
      }}
    >
      <AnimatePresence mode="popLayout">
        {toasts.map((notif) => (
          <NotificationToast
            key={notif.id}
            notif={notif}
            onDismiss={() => dismissNotification(notif.id)}
          />
        ))}
      </AnimatePresence>
    </div>
  )
}

interface ToastProps {
  notif: Notification
  onDismiss: () => void
}

function NotificationToast({ notif, onDismiss }: ToastProps) {
  const colors = NOTIFICATION_COLORS[notif.type] ?? NOTIFICATION_COLORS.change

  // Extract initials from message (first 2 chars of first word)
  const initials = (notif.message.split(' ')[0] ?? 'SY').slice(0, 2).toUpperCase()

  return (
    <motion.div
      layout
      initial={{ y: 16, opacity: 0, scale: 0.95 }}
      animate={{ y: 0, opacity: 1, scale: 1 }}
      exit={{ y: 16, opacity: 0, scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 380, damping: 30 }}
      className="cursor-pointer group"
      style={{
        background: 'rgba(4,8,22,0.92)',
        borderRadius: '10px',
        border: `0.6px solid ${colors.border}`,
        padding: '10px 14px',
      }}
      onClick={onDismiss}
    >
      <div className="flex items-center gap-3">
        {/* Avatar circle */}
        <div className="shrink-0 w-[22px] h-[22px] rounded-full flex items-center justify-center"
          style={{
            background: colors.avatarBg,
            border: `0.5px solid ${colors.border}`,
          }}
        >
          <span className="text-[12px] font-semibold" style={{ color: colors.icon }}>{initials}</span>
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <p className="text-[12px] text-text-primary leading-snug truncate">{notif.message}</p>
          {notif.detail && (
            <p className="text-[12px] text-text-secondary mt-0.5 truncate">{notif.detail}</p>
          )}
        </div>

        {/* Action link */}
        <span className="text-[12px] shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ color: '#00C8FF' }}
        >
          diff ↗
        </span>
      </div>
    </motion.div>
  )
}
