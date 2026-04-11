import { useRef } from 'react'

interface Props {
  onDelta: (deltaX: number) => void
}

export function ResizeHandle({ onDelta }: Props) {
  const lastX = useRef(0)

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    lastX.current = e.clientX

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - lastX.current
      lastX.current = ev.clientX
      if (delta !== 0) onDelta(delta)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  return (
    <div className="w-px shrink-0 bg-border relative z-10">
      <div
        onMouseDown={handleMouseDown}
        className="absolute inset-y-0 -left-0.5 -right-0.5 cursor-col-resize hover:bg-accent/40 active:bg-accent/60 transition-colors"
      />
    </div>
  )
}
