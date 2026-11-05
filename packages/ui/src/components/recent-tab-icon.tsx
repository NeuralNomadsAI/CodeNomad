import { Dynamic } from "solid-js/web"
import { Folder, Globe, Server } from "lucide-solid"
import type { LaunchableRecent } from "../lib/remote-project-recents"

/** A recent tab's kind, as the home page and the launcher show it: folder, remote project or SideCar. */
export default function RecentTabIcon(props: { recent: Pick<LaunchableRecent, "remote" | "sidecar">; class: string }) {
  return <Dynamic component={props.recent.sidecar ? Globe : props.recent.remote ? Server : Folder} class={props.class} aria-hidden="true" />
}
