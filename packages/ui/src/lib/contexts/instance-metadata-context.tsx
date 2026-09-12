import { Component, JSX, createContext, createEffect, createMemo, createSignal, useContext, type Accessor } from "solid-js"
import type { Instance } from "../../types/instance"
import { instances } from "../../stores/instances"
import { getInstanceMetadata } from "../../stores/instance-metadata"
import { getActiveCatalogLocation } from "../../stores/sessions"
import { loadInstanceMetadata, hasMetadataLoaded } from "../hooks/use-instance-metadata"

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

  const ensureMetadata = async (force = false) => {
    const loadId = ++metadataLoadId
    const current = resolvedInstance()
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
      await loadInstanceMetadata(current, { force, location })
    } finally {
      if (loadId === metadataLoadId) setIsLoading(false)
    }
  }

  createEffect(() => {
    const current = resolvedInstance()
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
