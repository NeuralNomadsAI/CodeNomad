import { Dynamic } from "solid-js/web"
import { Folder, Globe, Server } from "lucide-solid"
import type { LaunchableRecent } from "../lib/recent-open-target"

/** A recent tab's kind, as the home page and the launcher show it: folder, remote project or SideCar. */
export default function RecentTabIcon(props: { recent: Pick<LaunchableRecent, "kind">; class: string }) {
  return <Dynamic component={props.recent.kind === "sidecar" ? Globe : props.recent.kind === "remote" ? Server : Folder} class={props.class} aria-hidden="true" />
}
