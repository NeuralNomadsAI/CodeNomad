import { Show, createMemo } from "solid-js"
import { remoteServers } from "../stores/preferences"
import RemoteViewSession from "./remote-view-session"

export default function RemoteRecentSession(props: { profileId: string; active: boolean; onReady: () => void; onBack: () => void }) {
  const profile = createMemo(() => remoteServers().find((entry) => entry.id === props.profileId), undefined,
    { equals: (left, right) => JSON.stringify(left) === JSON.stringify(right) })
  return <Show when={profile()} keyed>
    {(profile) => <RemoteViewSession profile={profile} active={props.active} onBack={props.onBack} onReady={props.onReady} />}
  </Show>
}
