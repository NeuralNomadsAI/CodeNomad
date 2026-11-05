import { createSignal } from "solid-js"
import type { RemoteServerInput } from "../lib/hooks/use-remote-server-profiles"

/**
 * The server dialog Browse's "Add server" opens. It lives outside Browse, which
 * the launcher unmounts as it closes.
 */
export interface RemoteServerEditorRequest {
  /** Prefills the dialog; a saved server's id edits it instead of adding one. */
  initial?: RemoteServerInput
}

const [remoteServerEditor, setRemoteServerEditor] = createSignal<RemoteServerEditorRequest | null>(null)

export function openRemoteServerEditor(request: RemoteServerEditorRequest = {}): void {
  setRemoteServerEditor(request)
}

export function closeRemoteServerEditor(): void {
  setRemoteServerEditor(null)
}

export { remoteServerEditor }
