import { createContext, useContext } from "solid-js"
import { missionStore } from "../stores/missions"

/** The same bounded views, backed by the project or one exact isolated passage. */
const scope = createContext<() => typeof missionStore>()
export const MissionPanelScope = scope.Provider
export function scopedMissionStore(source: () => typeof missionStore): typeof missionStore {
  return new Proxy(missionStore, { get: (_target, key) => Reflect.get(source(), key) })
}
/** The panel's project acknowledgement scope within this window. */
const viewScope = createContext<() => string>()
export const MissionViewScope = viewScope.Provider
export function useMissionViewScope(): (() => string) | undefined { return useContext(viewScope) }

export function useMissionPanelStore() {
  const source = useContext(scope)
  return source ? scopedMissionStore(source) : missionStore
}
