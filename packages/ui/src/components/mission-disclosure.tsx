import { createUniqueId, type JSX } from "solid-js"
import { ChevronRight } from "lucide-solid"
import { missionDisclosureOpen, setMissionDisclosureOpen } from "../stores/mission-view-state"

export function MissionDisclosure(props: {
  missionId: string; name: string; title: JSX.Element; children: JSX.Element
  defaultOpen?: boolean; class?: string; label?: string; description?: string; actions?: JSX.Element
}) {
  const id = `mission-section-${createUniqueId()}`
  const open = () => missionDisclosureOpen(props.missionId, props.name, props.defaultOpen ?? true)
  return <section class={`mission-disclosure ${props.class ?? ""}`}>
    <h3><button type="button" class="mission-disclosure-trigger" aria-label={props.label} aria-description={props.description} aria-expanded={open()} aria-controls={id}
      onClick={() => setMissionDisclosureOpen(props.missionId, props.name, !open())}>
      <ChevronRight class="disclosure-chevron h-4 w-4" aria-hidden="true" />{props.title}
    </button>{props.actions}</h3>
    <div id={id} hidden={!open()}>{props.children}</div>
  </section>
}
