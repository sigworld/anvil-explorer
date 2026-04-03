import { EmptyState, PageSection } from '../components/common.tsx'
import { usePageMeta } from '../hooks/use-page-meta.ts'

type RouteProps = { default?: boolean }

export function NotFoundPage(_: RouteProps) {
  usePageMeta('Not Found', 'Page not found in Anvil Explorer.')
  return (
    <PageSection title="Not Found" description="The requested route does not exist">
      <EmptyState title="Unknown page" body="Use the navigation above to return to the explorer." />
    </PageSection>
  )
}
