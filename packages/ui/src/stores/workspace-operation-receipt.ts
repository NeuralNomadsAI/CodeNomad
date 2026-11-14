import { backends, localBackend, type BackendClient } from "../lib/backend-client"
import { captureBackendOperation } from "../lib/backend-operation"
import { backendEvents } from "../lib/backend-events"
import { instanceKey, LOCAL_BACKEND_ID } from "../lib/backend-identity"
import { RELAY_AUTHORITY_QUERY, isRelayAuthority } from "../../../server/src/codenomad-servers/relay-authority"
import { preferences } from "./preferences"

const attachments = new WeakMap<AbortSignal, number>()
let attachmentSequence = 0
export function workspaceRequestKey(backendId: string = LOCAL_BACKEND_ID, requestId?: string, attachment?: AbortSignal): string {
  if (attachment && !attachments.has(attachment)) attachments.set(attachment, ++attachmentSequence)
  return JSON.stringify([backendId, requestId, attachment && attachments.get(attachment)])
}

/** Memory-only authority, captured even when POST has not returned a workspace ID. */
export function captureWorkspaceOperation(directory: string, client: BackendClient = localBackend, requestId?: string, parent?: AbortSignal) {
  const backendId = client.id
  const attachment = backendEvents.signal(backendId)
  const admitted = () => backends.get(backendId) === client && (
    client === localBackend || preferences().multiBackend === true && !!client.admitRelayAuthority
      && isRelayAuthority(new URL(client.url("/api/workspaces")).searchParams.get(RELAY_AUTHORITY_QUERY))
  )
  if (!attachment || attachment.aborted || !admitted()) throw new Error(`Backend unavailable: ${backendId}`)
  const operation = captureBackendOperation(instanceKey(backendId, ""), parent, admitted)
  return Object.freeze({ backendId, client, api: client.api, attachment, directory, requestId,
    rawId: undefined as string | undefined, instanceId: undefined as string | undefined,
    requestKey: workspaceRequestKey(backendId, requestId, attachment), signal: operation.signal,
    current: operation.current,
    // Claim settlement retains the captured API after UI demand or attachment is revoked.
    attached: () => !attachment.aborted && backendEvents.signal(backendId) === attachment && admitted(),
  })
}

export type WorkspaceOperationReceipt = ReturnType<typeof captureWorkspaceOperation>
