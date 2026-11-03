import { Show, type Accessor } from "solid-js"
import type { IntegrationView } from "../../../server/src/integration-types"

/** The body of one integration's Status section. */
export function IntegrationSection(props: { t: (key: string, vars?: Record<string, any>) => string; entry: Accessor<IntegrationView | undefined> }) {
  return <Show when={props.entry()}>{entry => <div class="integration-section" data-integration-section={entry().id} />}</Show>
}
