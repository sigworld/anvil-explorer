import { EmptyState, PageSection } from '../components/common.tsx'

type RouteProps = { default?: boolean }

export function NotFoundPage(_: RouteProps) {
  return (
    <PageSection title="Not Found" description="The requested route does not exist">
      <EmptyState title="Unknown page" body="Use the navigation above to return to the explorer." />
    </PageSection>
  )
}
