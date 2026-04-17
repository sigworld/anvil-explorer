import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

export function useFlowFullscreen() {
  const [fullscreen, setFullscreen] = useState(false)
  const reactFlowInstance = useRef<{ fitView: () => void } | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const toggle = useCallback(() => {
    setFullscreen((prev) => !prev)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => reactFlowInstance.current?.fitView(), 50)
  }, [])

  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [])

  useEffect(() => {
    if (!fullscreen) return
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFullscreen(false)
    }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [fullscreen])

  const onInit = useCallback((instance: { fitView: () => void }) => {
    reactFlowInstance.current = instance
  }, [])

  return { fullscreen, toggle, onInit }
}
