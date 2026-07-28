import type { Accessor } from "solid-js"

export interface WorkflowTabProps {
  t: (key: string, vars?: Record<string, any>) => string
  instanceId: string
  activeSessionId: Accessor<string | null>
  active: Accessor<boolean>
}

export interface WorkflowBuilderProps extends WorkflowTabProps {
  onError: (message: string) => void
}
