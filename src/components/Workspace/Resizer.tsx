import { useCallback, useRef, useState } from 'react'

interface Props {
  orientation: 'vertical' | 'horizontal'
  /** Current size in px of the panel being resized. */
  size: number
  onResize: (next: number) => void
  /** Which way the panel grows relative to pointer movement. */
  invert?: boolean
  label: string
  min: number
  max: number
}

/**
 * A docked-panel resize handle.
 *
 * Uses pointer capture so a fast drag that leaves the 7px hit area still tracks
 * (the common failure of naive mousemove handlers), and reports sizes through a
 * ref-tracked base so repeated drags never accumulate rounding drift.
 *
 * Keyboard operable: arrow keys nudge, Shift+arrow jumps — the workspace has to
 * be fully usable without a mouse.
 */
export function Resizer({ orientation, size, onResize, invert, label, min, max }: Props) {
  const [dragging, setDragging] = useState(false)
  const start = useRef({ pos: 0, size: 0 })
  const vertical = orientation === 'vertical'

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    start.current = { pos: vertical ? e.clientX : e.clientY, size }
    setDragging(true)
  }, [size, vertical])

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    const delta = (vertical ? e.clientX : e.clientY) - start.current.pos
    onResize(start.current.size + (invert ? -delta : delta))
  }, [invert, onResize, vertical])

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    setDragging(false)
  }, [])

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 40 : 8
    const dec = vertical ? 'ArrowLeft' : 'ArrowUp'
    const inc = vertical ? 'ArrowRight' : 'ArrowDown'
    if (e.key !== dec && e.key !== inc) return
    e.preventDefault()
    const dir = e.key === inc ? 1 : -1
    onResize(size + (invert ? -dir : dir) * step)
  }, [invert, onResize, size, vertical])

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-valuenow={Math.round(size)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className={`resizer ${vertical ? 'resizer-v' : 'resizer-h'}${dragging ? ' is-dragging' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    />
  )
}
