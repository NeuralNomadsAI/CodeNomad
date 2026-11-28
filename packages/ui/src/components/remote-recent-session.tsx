import { Show, createEffect } from "solid-js"
import { remoteRecentProjectsUsable, savedProjectProfile, type RemoteRecentProject } from "../stores/recent-projects"
import { RemoteServerBrowser } from "./remote-server-browser"

export default function RemoteRecentSession(props: {
  recent: RemoteRecentProject; active: boolean; onBack: () => void; onOpened: (instanceId: string) => void
}) {
  const profile = () => remoteRecentProjectsUsable() && savedProjectProfile(props.recent.policy)
  createEffect(() => { if (!profile()) props.onBack() })
  return <Show when={profile()}>{server =>
    <div data-remote-view-session on:keydown={event => {
      if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); props.onBack() }
    }}>
      <RemoteServerBrowser profile={server()} recent={props.recent} active={props.active} onBack={props.onBack} onOpened={props.onOpened} />
    </div>
  }</Show>
}
