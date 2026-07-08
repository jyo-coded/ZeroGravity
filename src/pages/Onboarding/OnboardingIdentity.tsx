import { useState } from 'react'
import { motion } from 'framer-motion'
import { User, Palette } from 'lucide-react'
import { useAppStore } from '../../store/appStore'

const AVATAR_COLORS = [
  '#38BDF8', '#22C55E', '#F59E0B', '#A78BFA',
  '#F472B6', '#34D399', '#FB923C', '#60A5FA',
  '#E879F9', '#4ADE80',
]

export function OnboardingIdentity() {
  const { setIdentity, setView } = useAppStore()
  const [username, setUsername] = useState('')
  const [avatarColor, setAvatarColor] = useState(AVATAR_COLORS[0])

  const canContinue = username.trim().length >= 2

  return (
    <div className="min-h-screen bg-bg-base flex items-center justify-center">
      <div className="absolute inset-0 bg-gradient-radial pointer-events-none" />

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        className="glass-elevated rounded-2xl border border-bg-border/60 w-full max-w-md mx-4 overflow-hidden"
      >
        {/* Logo header */}
        <div className="px-8 pt-8 pb-6 text-center border-b border-bg-border">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-accent/10 border border-accent/20 mb-4 accent-glow">
            <span className="text-2xl font-black text-gradient">0G</span>
          </div>
          <h1 className="text-xl font-bold text-text-primary mb-1">Welcome to 0G</h1>
          <p className="text-sm text-text-secondary">Intelligent Collaborative Workspace</p>
        </div>

        <div className="px-8 py-6">
          <p className="text-xs text-text-muted uppercase tracking-widest mb-5 font-semibold">
            Step 1 of 3 — Your Identity
          </p>

          {/* Avatar preview */}
          <div className="flex justify-center mb-6">
            <motion.div
              animate={{ backgroundColor: avatarColor }}
              transition={{ duration: 0.3 }}
              className="w-16 h-16 rounded-full flex items-center justify-center text-bg-base font-bold text-xl"
            >
              {username.trim() ? username.slice(0, 2).toUpperCase() : <User size={24} />}
            </motion.div>
          </div>

          {/* Username */}
          <div className="mb-5">
            <label className="block text-xs text-text-secondary mb-2 font-medium">Username</label>
            <input
              type="text"
              placeholder="jyo"
              value={username}
              onChange={(e) => setUsername(e.target.value.slice(0, 20))}
              className="input-field"
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && canContinue && proceed()}
            />
            <p className="text-xs text-text-muted mt-1.5">Visible to your teammates</p>
          </div>

          {/* Color picker */}
          <div className="mb-8">
            <label className="flex items-center gap-1.5 text-xs text-text-secondary mb-3 font-medium">
              <Palette size={12} />
              Avatar color
            </label>
            <div className="flex flex-wrap gap-2">
              {AVATAR_COLORS.map((color) => (
                <button
                  key={color}
                  onClick={() => setAvatarColor(color)}
                  className="w-7 h-7 rounded-full transition-transform hover:scale-110 active:scale-95"
                  style={{
                    backgroundColor: color,
                    outline: avatarColor === color ? `2px solid ${color}` : '2px solid transparent',
                    outlineOffset: '2px',
                  }}
                />
              ))}
            </div>
          </div>

          <button
            onClick={proceed}
            disabled={!canContinue}
            className="btn-primary w-full justify-center py-3 rounded-xl disabled:opacity-40"
          >
            Continue
          </button>
        </div>
      </motion.div>
    </div>
  )

  async function proceed() {
    if (!canContinue) return
    await setIdentity({ username: username.trim(), avatar_color: avatarColor })
    setView('onboarding_model')
  }
}
