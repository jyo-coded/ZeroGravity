/**
 * NebulaLayer — ambient gradient overlays matching SVG concept.
 *
 * SVG radial gradients:
 *   bg1: #001828 → #000408 (cx=15%, cy=20%, r=55%)
 *   bg2: #0D0020 → #000408 (cx=85%, cy=80%, r=45%)
 *
 * Plus floating glow orbs with nebulaBreathe animation.
 */

export function NebulaLayer() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
      {/* ─── SVG-matched background gradients ──────────────────────────────── */}
      {/* bg1: cyan-tinted deep space — top-left origin */}
      <div
        className="absolute inset-0"
        style={{
          background: 'radial-gradient(ellipse 110% 110% at 15% 20%, #001828 0%, #000408 100%)',
          opacity: 0.9,
          animation: 'nebulaBreathe 15s ease-in-out infinite',
        }}
      />

      {/* bg2: purple-tinted deep space — bottom-right origin */}
      <div
        className="absolute inset-0"
        style={{
          background: 'radial-gradient(ellipse 90% 90% at 85% 80%, #0D0020 0%, #000408 100%)',
          opacity: 0.8,
          animation: 'nebulaBreathe 18s ease-in-out 3s infinite',
        }}
      />

      {/* ─── Glow orbs — subtle floating light sources ─────────────────────── */}
      {/* Cyan orb — top-left area */}
      <div
        className="absolute rounded-full"
        style={{
          width: '600px',
          height: '600px',
          left: '-5%',
          top: '10%',
          background: 'radial-gradient(circle, rgba(0, 200, 255, 0.04) 0%, transparent 70%)',
          filter: 'blur(80px)',
          animation: 'nebulaBreathe 20s ease-in-out infinite',
        }}
      />

      {/* Purple orb — right area */}
      <div
        className="absolute rounded-full"
        style={{
          width: '500px',
          height: '400px',
          right: '-8%',
          top: '15%',
          background: 'radial-gradient(circle, rgba(139, 92, 246, 0.035) 0%, transparent 70%)',
          filter: 'blur(100px)',
          animation: 'nebulaBreathe 22s ease-in-out 5s infinite',
        }}
      />

      {/* Green orb — bottom area */}
      <div
        className="absolute rounded-full"
        style={{
          width: '400px',
          height: '400px',
          left: '40%',
          bottom: '-5%',
          background: 'radial-gradient(circle, rgba(0, 255, 136, 0.02) 0%, transparent 70%)',
          filter: 'blur(90px)',
          animation: 'nebulaBreathe 25s ease-in-out 8s infinite',
        }}
      />
    </div>
  )
}
