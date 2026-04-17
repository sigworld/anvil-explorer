type FullscreenButtonProps = {
  fullscreen: boolean
  onClick: () => void
}

export function FullscreenButton(props: FullscreenButtonProps) {
  return (
    <button
      type="button"
      class="flow-fullscreen-btn"
      title={props.fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
      onClick={props.onClick}
    >
      {props.fullscreen
        ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" /></svg>
        : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>}
    </button>
  )
}
