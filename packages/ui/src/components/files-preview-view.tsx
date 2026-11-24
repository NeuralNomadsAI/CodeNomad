import { Show } from "solid-js"
import type { FilePreviewTarget } from "../stores/files-preview"
import { GitDiffView } from "./git-diff-view"
import { WorkspaceFileView } from "./workspace-file-view"

export function FilesPreviewView(props: { instanceId: string; target: FilePreviewTarget; active: boolean; onClose: () => void; onInsertComment?: (text: string) => void }) {
  return <Show when={props.target.kind === "workspace"} fallback={<GitDiffView {...props} />}>
    <WorkspaceFileView {...props} />
  </Show>
}
