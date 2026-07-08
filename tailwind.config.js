/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // ─── Zero Gravity Radical UI Design System ────────────────────────
        // Backgrounds — deep space layering (SVG-accurate)
        void:    '#000408',   // deepest background — matches SVG bg gradient end
        deep:    '#000510',   // main app background — matches SVG panel fills
        panel:   '#02040C',   // sidebar / panel backgrounds
        card:    '#040816',   // floating card surfaces
        surface: '#0A1020',   // elevated surfaces, inputs
        border:  '#1A1A33',   // subtle borders

        // Legacy aliases (keeps onboarding pages working without changes)
        bg: {
          base:     '#000408',
          surface:  '#02040C',
          elevated: '#040816',
          border:   '#1A1A33',
        },

        // Accent system — SVG-matched colors
        cyan: {
          DEFAULT: '#00C8FF',   // SVG primary cyan
          light:   '#66F0FF',
          dim:     'rgba(0, 200, 255, 0.12)',
          glow:    'rgba(0, 200, 255, 0.30)',
          muted:   'rgba(0, 200, 255, 0.06)',
        },
        purple: {
          DEFAULT: '#8B5CF6',   // SVG purple
          light:   '#A78BFA',
          dim:     'rgba(139, 92, 246, 0.12)',
          glow:    'rgba(139, 92, 246, 0.30)',
        },
        green: {
          DEFAULT: '#00FF88',   // SVG green (brighter)
          light:   '#6AE08A',
          dim:     'rgba(0, 255, 136, 0.12)',
          glow:    'rgba(0, 255, 136, 0.30)',
        },
        orange: {
          DEFAULT: '#FFA500',   // SVG orange
          dim:     'rgba(255, 165, 0, 0.12)',
        },
        red: {
          DEFAULT: '#FF453A',
          dim:     'rgba(255, 69, 58, 0.12)',
        },

        // Legacy accent aliases (keeps existing component refs working)
        accent: {
          DEFAULT: '#00C8FF',
          light:   '#66F0FF',
          dim:     'rgba(0, 200, 255, 0.12)',
          glow:    'rgba(0, 200, 255, 0.30)',
        },
        success: '#00FF88',
        warning: '#FFA500',
        error:   '#FF453A',

        // Text — SVG-accurate
        text: {
          primary:   '#E2E8F0',   // SVG primary text
          secondary: '#94A3B8',   // SVG secondary text
          muted:     '#64748B',   // SVG muted text
          dim:       '#2D3748',   // SVG very dim text (placeholders)
        },
      },

      fontFamily: {
        sans:    ['Inter', 'system-ui', 'sans-serif'],
        mono:    ['IBM Plex Mono', 'JetBrains Mono', 'monospace'],
        display: ['IBM Plex Mono', 'JetBrains Mono', 'monospace'],
      },

      backdropBlur: {
        glass:  '12px',
        heavy:  '24px',
      },

      boxShadow: {
        // Glow shadows — SVG-matched
        'glow':       '0 0 20px rgba(0, 200, 255, 0.25)',
        'glow-sm':    '0 0 10px rgba(0, 200, 255, 0.15)',
        'glow-lg':    '0 0 40px rgba(0, 200, 255, 0.30)',
        'glow-cyan':  '0 0 30px rgba(0, 200, 255, 0.25), 0 0 60px rgba(0, 200, 255, 0.10)',
        'glow-purple':'0 0 30px rgba(139, 92, 246, 0.25), 0 0 60px rgba(139, 92, 246, 0.10)',
        'glow-green': '0 0 30px rgba(0, 255, 136, 0.25), 0 0 60px rgba(0, 255, 136, 0.10)',
        // Structural shadows
        'panel':      '0 4px 24px rgba(0, 0, 0, 0.5)',
        'card':       '0 8px 32px rgba(0, 0, 0, 0.4), 0 2px 8px rgba(0, 0, 0, 0.3)',
        'card-hover': '0 12px 48px rgba(0, 0, 0, 0.5), 0 4px 16px rgba(0, 0, 0, 0.4)',
        'topbar':     '0 1px 0 rgba(255, 255, 255, 0.03), 0 4px 16px rgba(0, 0, 0, 0.4)',
      },

      borderRadius: {
        'card': '14px',
        'panel': '12px',
      },

      animation: {
        'twinkle':         'twinkle var(--tw-duration, 4s) ease-in-out infinite',
        'star-pulse':      'starPulse 3s ease-in-out infinite',
        'cursor-blink':    'cursorBlink 1s steps(2) infinite',
        'live-pulse':      'livePulse 2s ease-in-out infinite',
        'think-dot':       'thinkDot 1.4s ease-in-out infinite',
        'nebula-breathe':  'nebulaBreathe 12s ease-in-out infinite',
        'peer-pulse':      'peerPulse 2s ease-out infinite',
        'warp-glow':       'warpGlow 0.6s ease-out',
        'beam-shimmer':    'beamShimmer 1.5s infinite',
        // Legacy (kept for compatibility)
        'star-twinkle':    'starTwinkle 4s ease-in-out infinite',
        'nebula-pulse':    'nebulaPulse 8s ease-in-out infinite',
        'card-hover-lift': 'cardHoverLift 0.3s ease-out forwards',
        'ai-cursor-blink': 'cursorBlink 1s steps(2) infinite',
        'shimmer':         'shimmer 1.5s infinite',
        'cockpit-pulse':   'cockpitPulse 2s ease-in-out infinite',
        'ring-expand':     'ringExpand 2s ease-out infinite',
        'slide-in-left':   'slideInLeft 0.3s ease-out',
        'slide-in-right':  'slideInRight 0.3s ease-out',
        'fade-up':         'fadeUp 0.4s ease-out',
        'pulse-glow':      'pulseGlow 2s ease-in-out infinite',
        'spin-slow':       'spin 3s linear infinite',
      },

      keyframes: {
        twinkle: {
          '0%, 100%': { opacity: 'var(--star-base-opacity, 0.3)' },
          '50%':      { opacity: 'var(--star-peak-opacity, 0.8)' },
        },
        starPulse: {
          '0%, 100%': { boxShadow: '0 0 2px rgba(0,200,255,0.3)' },
          '50%':      { boxShadow: '0 0 8px rgba(0,200,255,0.6)' },
        },
        cursorBlink: {
          '0%, 49%': { opacity: '1' },
          '50%, 100%': { opacity: '0' },
        },
        livePulse: {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%':      { opacity: '0.5', transform: 'scale(1.3)' },
        },
        thinkDot: {
          '0%, 80%, 100%': { opacity: '0.3', transform: 'scale(0.8)' },
          '40%':           { opacity: '1', transform: 'scale(1)' },
        },
        nebulaBreathe: {
          '0%, 100%': { opacity: '0.7', transform: 'scale(1)' },
          '50%':      { opacity: '1', transform: 'scale(1.03)' },
        },
        peerPulse: {
          '0%':   { transform: 'scale(1)', opacity: '0.4' },
          '100%': { transform: 'scale(1.8)', opacity: '0' },
        },
        warpGlow: {
          '0%':   { opacity: '0', boxShadow: '0 0 0 rgba(0,255,136,0)' },
          '50%':  { opacity: '1', boxShadow: '0 0 30px rgba(0,255,136,0.4)' },
          '100%': { opacity: '0', boxShadow: '0 0 0 rgba(0,255,136,0)' },
        },
        beamShimmer: {
          '0%':   { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        // Legacy keyframes
        starTwinkle: {
          '0%, 100%': { opacity: '0.3' },
          '50%':      { opacity: '1' },
        },
        nebulaPulse: {
          '0%, 100%': { opacity: '0.4', transform: 'scale(1)' },
          '50%':      { opacity: '0.7', transform: 'scale(1.05)' },
        },
        cardHoverLift: {
          '0%':   { transform: 'translateY(0)', boxShadow: '0 8px 32px rgba(0,0,0,0.4)' },
          '100%': { transform: 'translateY(-4px)', boxShadow: '0 16px 48px rgba(0,0,0,0.5), 0 0 20px rgba(0,200,255,0.1)' },
        },
        cockpitPulse: {
          '0%, 100%': { boxShadow: '0 0 8px rgba(0,200,255,0.3)' },
          '50%':      { boxShadow: '0 0 20px rgba(0,200,255,0.6)' },
        },
        ringExpand: {
          '0%':   { transform: 'scale(1)', opacity: '0.6' },
          '100%': { transform: 'scale(2.5)', opacity: '0' },
        },
        shimmer: {
          '0%':   { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        slideInLeft: {
          '0%':   { transform: 'translateX(-20px)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        slideInRight: {
          '0%':   { transform: 'translateX(20px)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        fadeUp: {
          '0%':   { transform: 'translateY(12px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        pulseGlow: {
          '0%, 100%': { boxShadow: '0 0 10px rgba(0, 200, 255, 0.15)' },
          '50%':      { boxShadow: '0 0 25px rgba(0, 200, 255, 0.4)' },
        },
      },
    },
  },
  plugins: [],
}
