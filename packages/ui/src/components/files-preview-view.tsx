import { Show } from "solid-js"
import type { FilePreviewTarget } from "../stores/files-preview"
import { GitDiffView } from "./git-diff-view"
import { WorkspaceFileView } from "./workspace-file-view"
import { ProjectCapabilityBoundary } from "./project-capability-gate"

export function FilesPreviewView(props: { instanceId: string; target: FilePreviewTarget; active: boolean; onClose: () => void; onInsertComment?: (text: string) => void; focusWithin?: () => HTMLElement | undefined; onRemovedFocus?: () => void }) {
  return <ProjectCapabilityBoundary instanceId={props.instanceId} feature={props.target.kind === "workspace" ? "files" : "git"} focusWithin={props.focusWithin} onRemovedFocus={props.onRemovedFocus}>
    <Show when={props.target.kind === "workspace"} fallback={<GitDiffView {...props} />}>
    <WorkspaceFileView {...props} />
  </Show></ProjectCapabilityBoundary>
}
