import { Component, JSX, createContext, createEffect, createMemo, createSignal, onCleanup, useContext, type Accessor } from "solid-js"
import type { Instance } from "../../types/instance"
import { instances, waitForInstanceInitialSessionHydration } from "../../stores/instances"
import { getInstanceMetadata } from "../../stores/instance-metadata"
import { getActiveCatalogLocation } from "../../stores/sessions"
import { loadInstanceMetadata, hasMetadataLoaded } from "../hooks/use-instance-metadata"
import { captureBackendOperation } from "../backend-operation"
import { backendEvents } from "../server-events"

interface InstanceMetadataContextValue {
  isLoading: Accessor<boolean>
  instance: Accessor<Instance>
  metadata: Accessor<Instance["metadata"] | undefined>
  refreshMetadata: () => Promise<void>
}

const InstanceMetadataContext = createContext<InstanceMetadataContextValue | null>(null)

interface InstanceMetadataProviderProps {
  instance: Instance
  children: JSX.Element
}

export const InstanceMetadataProvider: Component<InstanceMetadataProviderProps> = (props) => {
  const resolvedInstance = createMemo(() => instances().get(props.instance.id) ?? props.instance)
  const [isLoading, setIsLoading] = createSignal(true)
  let metadataLoadId = 0
  let disposed = false
  let attachment: AbortSignal | undefined
  onCleanup(() => { disposed = true; metadataLoadId++ })

  const ensureMetadata = async (force = false) => {
    const loadId = ++metadataLoadId
    const current = resolvedInstance()
    const operation = captureBackendOperation(current.id, undefined, () => !disposed)
    if (!operation.current()) return
    if (!current) {
      if (loadId === metadataLoadId) setIsLoading(false)
      return
    }

    const cachedMetadata = getInstanceMetadata(current.id) ?? current.metadata
    const location = getActiveCatalogLocation(current.id)
    if (!force && hasMetadataLoaded(cachedMetadata, location)) {
      if (loadId === metadataLoadId) setIsLoading(false)
      return
    }

    setIsLoading(true)
    try {
      // Initial session reads get the limited per-origin browser connections
      // before MCP/plugin/project decoration for each restored project pane.
      await waitForInstanceInitialSessionHydration(current.id)
      if (!operation.current() || loadId !== metadataLoadId || resolvedInstance()?.client !== current.client) return
      await loadInstanceMetadata(current, { force, location })
    } finally {
      if (operation.current() && loadId === metadataLoadId) setIsLoading(false)
    }
  }

  createEffect(() => {
    const current = resolvedInstance()
    const signal = backendEvents.signalForInstance(current.id)
    const replaced = attachment !== undefined && attachment !== signal
    attachment = signal
    if (signal.aborted) return
    if (replaced) { void ensureMetadata(true); return }
    if (!current) {
      setIsLoading(false)
      return
    }

    const tracked = getInstanceMetadata(current.id) ?? current.metadata
    const location = getActiveCatalogLocation(current.id)
    if (!tracked || !hasMetadataLoaded(tracked, location)) {
      void ensureMetadata()
      return
    }

    setIsLoading(false)
  })

  const contextValue: InstanceMetadataContextValue = {
    isLoading,
    instance: resolvedInstance,
    metadata: () => getInstanceMetadata(resolvedInstance().id) ?? resolvedInstance().metadata,
    refreshMetadata: () => ensureMetadata(true),
  }

  return (
    <InstanceMetadataContext.Provider value={contextValue}>
      {props.children}
    </InstanceMetadataContext.Provider>
  )
}

export function useInstanceMetadataContext(): InstanceMetadataContextValue {
  const ctx = useContext(InstanceMetadataContext)
  if (!ctx) {
    throw new Error("useInstanceMetadataContext must be used within InstanceMetadataProvider")
  }
  return ctx
}

export function useOptionalInstanceMetadataContext(): InstanceMetadataContextValue | null {
  return useContext(InstanceMetadataContext)
}
