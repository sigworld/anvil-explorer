import { useEffect } from 'preact/hooks'

const BASE_TITLE = 'Anvil Explorer'

/**
 * Sets the document title and meta description for the current page.
 */
export function usePageMeta(title: string, description: string) {
  useEffect(() => {
    document.title = title ? `${title} — ${BASE_TITLE}` : BASE_TITLE

    let meta = document.querySelector('meta[name="description"]') as HTMLMetaElement | null
    if (!meta) {
      meta = document.createElement('meta')
      meta.name = 'description'
      document.head.appendChild(meta)
    }
    meta.content = description

    return () => {
      document.title = BASE_TITLE
    }
  }, [title, description])
}
