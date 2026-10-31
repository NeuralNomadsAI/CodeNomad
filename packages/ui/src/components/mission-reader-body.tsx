import { Show, createMemo, mapArray } from "solid-js"
import type { MissionPanelMap } from "../../../server/src/api-types"
import type { MissionContentSelector } from "../../../server/src/missions/mission-content-wire"
import { useI18n } from "../lib/i18n"
import { missionOwnBody } from "../lib/mission-bodies"
import { missionBodySource, useMissionBodyValue, type MissionBodySource } from "../stores/mission-content"

/** A string body a reader section pages through the content route. */
export type MissionReaderBody = MissionBodySource

/** The body of a one-time mission at `selector`; undefined for a passage, whose readers
 * keep its own map and archived pages. */
export function missionReaderBody(instanceId: string, mission: MissionPanelMap | undefined, oneTime: boolean,
  selector: MissionContentSelector): MissionReaderBody | undefined {
  return mission && oneTime ? missionBodySource(instanceId, mission, selector) : undefined
}

interface ReaderValueProps {
  instanceId: () => string
  mission: () => MissionPanelMap | undefined
  oneTime: () => boolean
  /** Where the body is; undefined when the map records none. A passage's comes from its own map. */
  selector: () => MissionContentSelector | undefined
  /** False while the body is hidden (a closed disclosure): nothing is read and nothing settles. */
  active?: () => boolean
}

/** How a whole-value section stands: its value settled (shown), and its last read failed;
 * a failure shows beside the last good value, with an explicit retry. */
export interface MissionBodyRead { settled: boolean; failed: boolean; onRetry: () => void }

/** A body shown whole (a list, artifact, briefing or plan-change pair): a one-time
 * mission's through the content route, a passage's from its own map. An absent body is
 * settled and empty. */
export function useReaderValue<T>(props: ReaderValueProps) {
  const read = useMissionBodyValue<T | undefined>(() => {
    const selector = props.selector(), mission = props.mission()
    return selector && mission && props.oneTime() && (props.active?.() ?? true) ? missionBodySource(props.instanceId(), mission, selector) : undefined
  })
  const remote = () => props.oneTime() && props.selector() !== undefined
  const settled = () => !remote() || read.settled(), failed = () => remote() && read.failed()
  return {
    value: (): T | undefined => {
      if (remote()) return read.value()
      const selector = props.selector()
      return selector && missionOwnBody<T>(props.mission(), selector)
    },
    settled,
    failed,
    read: (): MissionBodyRead => ({ settled: settled(), failed: failed(), onRetry: read.retry }),
    retry: read.retry,
  }
}

/** Several whole bodies at once (the overview's recorded results and obstacles), each read
 * like `useReaderValue`; settled once all are. */
export function useReaderValues<T>(props: Omit<ReaderValueProps, "selector"> & { items: () => MissionContentSelector[] }) {
  const keys = createMemo(() => props.items().map(selector => JSON.stringify(selector)), [], {
    equals: (left, right) => left.length === right.length && left.every((key, index) => key === right[index]) })
  const reads = mapArray(keys, key => useReaderValue<T>({ ...props,
    selector: () => props.items().find(selector => JSON.stringify(selector) === key) }))
  const retry = () => { for (const read of reads()) if (read.failed()) read.retry() }
  return {
    values: () => reads().map(read => read.value()),
    read: (): MissionBodyRead => ({ settled: reads().every(read => read.settled()), failed: reads().some(read => read.failed()), onRetry: retry }),
  }
}

/** Where a body is not shown yet (reading), or a failed read with its explicit retry,
 * shown in place of the body or beside its last good page. `changed`: an input changed
 * since the snapshot an intent started from; its action (`actionLabel`, Retry unless
 * given) starts again from the current one. */
export function MissionBodyPending(props: { failed: boolean; changed?: boolean; onRetry: () => void; actionLabel?: string }) {
  const { t } = useI18n()
  return <p role="status">{t(props.changed ? "missions.control.reader.changed" : props.failed ? "missions.control.reader.unavailable" : "missions.control.loading")}
    <Show when={props.failed || props.changed}>{" "}<button type="button" class="window-text-button"
      onClick={() => props.onRetry()}>{t(props.actionLabel ?? "missions.control.retry")}</button></Show>
  </p>
}
