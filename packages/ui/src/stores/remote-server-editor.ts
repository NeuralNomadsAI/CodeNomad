import { createSignal } from "solid-js"
import type { RemoteServerInput } from "../lib/hooks/use-remote-server-profiles"

/**
 * The server dialog Remotes opens: editing a saved server, or adding one whose
 * pasted address needs a choice (a certificate that failed the check). It lives
 * outside Remotes, which the launcher unmounts as it closes.
 */
export interface RemoteServerEditorRequest {
  initial: RemoteServerInput
  initialError?: string
}

const [remoteServerEditor, setRemoteServerEditor] = createSignal<RemoteServerEditorRequest | null>(null)

export function openRemoteServerEditor(request: RemoteServerEditorRequest): void {
  setRemoteServerEditor(request)
}

export function closeRemoteServerEditor(): void {
  setRemoteServerEditor(null)
}

export { remoteServerEditor }
