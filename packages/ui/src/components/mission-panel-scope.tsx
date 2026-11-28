import { createContext, useContext } from "solid-js"

/** The panel's project acknowledgement scope within this window. */
const viewScope = createContext<() => string>()
export const MissionViewScope = viewScope.Provider
export function useMissionViewScope(): (() => string) | undefined { return useContext(viewScope) }
