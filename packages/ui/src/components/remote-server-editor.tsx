import { Show, type Component } from "solid-js"
import { useRemoteServerProfiles, type RemoteServerInput } from "../lib/hooks/use-remote-server-profiles"
import { closeRemoteServerEditor, remoteServerEditor } from "../stores/remote-server-editor"
import { RemoteServerDialog } from "./remote-server-dialog"

/** The server dialog Remotes asks for; saving keeps the server's id, so its storage and sign-in stay. */
export const RemoteServerEditor: Component = () => {
  const { saveProfile, openServer } = useRemoteServerProfiles()

  const submit = async (input: RemoteServerInput, open: boolean) => {
    const { profile, entryUrl } = await saveProfile(input)
    // A re-entered pairing link is consumed where the server opens.
    if (open || entryUrl) openServer(profile, entryUrl)
  }

  return (
    <Show when={remoteServerEditor()}>
      {(request) => (
        <RemoteServerDialog
          open
          initial={request().initial}
          initialError={request().initialError}
          onOpenChange={(open) => { if (!open) closeRemoteServerEditor() }}
          onSubmit={submit}
        />
      )}
    </Show>
  )
}
