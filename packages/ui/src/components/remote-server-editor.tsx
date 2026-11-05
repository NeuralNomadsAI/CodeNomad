import { Show, type Component } from "solid-js"
import { useRemoteServerProfiles } from "../lib/hooks/use-remote-server-profiles"
import { closeRemoteServerEditor, remoteServerEditor } from "../stores/remote-server-editor"
import { RemoteServerDialog } from "./remote-server-dialog"

/** The server dialog Browse asks for; saving keeps a saved server's id, so its storage and sign-in stay. */
export const RemoteServerEditor: Component = () => {
  const { submitServer } = useRemoteServerProfiles()

  return (
    <Show when={remoteServerEditor()}>
      {(request) => (
        <RemoteServerDialog
          open
          initial={request().initial}
          onOpenChange={(open) => { if (!open) closeRemoteServerEditor() }}
          onSubmit={submitServer}
        />
      )}
    </Show>
  )
}
