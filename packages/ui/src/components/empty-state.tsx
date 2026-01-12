import { Component } from "solid-js"
import { Loader2 } from "lucide-solid"

const codeNomadIcon = new URL("../images/EraCode-Icon.png", import.meta.url).href

interface EmptyStateProps {
  onSelectFolder: () => void
  isLoading?: boolean
}

const EmptyState: Component<EmptyStateProps> = (props) => {
  return (
    <div class="flex h-full w-full items-center justify-center bg-surface-secondary">
      <div class="max-w-[500px] px-8 py-12 text-center">
        <div class="mb-8 flex justify-center">
          <img src={codeNomadIcon} alt="Era Code logo" class="h-24 w-auto" loading="lazy" />
        </div>

        <h1 class="mb-3 text-3xl font-semibold text-primary">Era Code</h1>
        <p class="mb-8 text-base text-secondary">Select a folder to start coding with AI</p>


        <button
          onClick={props.onSelectFolder}
          disabled={props.isLoading}
          class="mb-4 button-primary"
        >
          {props.isLoading ? (
            <>
              <Loader2 class="h-4 w-4 animate-spin" />
              Selecting...
            </>
          ) : (
            "Select Folder"
          )}
        </button>

        <p class="text-sm text-muted">
          Keyboard shortcut: {navigator.platform.includes("Mac") ? "Cmd" : "Ctrl"}+N
        </p>

        <div class="mt-6 space-y-1 text-sm text-muted">
          <p>Examples: ~/projects/my-app</p>
          <p>You can have multiple instances of the same folder</p>
        </div>
      </div>
    </div>
  )
}

export default EmptyState
