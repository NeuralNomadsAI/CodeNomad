import { Component, For, Show, createSignal, createResource } from "solid-js"
import {
  GitCompare,
  FileCode,
  AlertTriangle,
  CheckCircle,
  XCircle,
  RefreshCw,
  ChevronDown,
  ChevronRight,
} from "lucide-solid"
import { cn } from "../lib/cn"
import { getLogger } from "../lib/logger"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Badge,
  Button,
  Separator,
} from "./ui"

const log = getLogger("refactoring-impact-preview")

interface ImpactResult {
  operation: string
  target: string
  affectedFiles: string[]
  references: number
  warnings: string[]
  safe: boolean
}

interface RefactoringImpactPreviewProps {
  folder: string
  operation?: string
  target?: string
  onApprove?: () => void
  onReject?: () => void
}

const RefactoringImpactPreview: Component<RefactoringImpactPreviewProps> = (props) => {
  const [showFiles, setShowFiles] = createSignal(true)

  const [impact, { refetch }] = createResource(
    () => ({ folder: props.folder, operation: props.operation, target: props.target }),
    async (params) => {
      if (!params.operation || !params.target) return null

      try {
        const res = await fetch("/api/era/refactoring/impact", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            folder: params.folder,
            operation: params.operation,
            target: params.target,
          }),
        })
        if (!res.ok) return null
        return (await res.json()) as ImpactResult
      } catch (err) {
        log.error("Failed to analyze impact", err)
        return null
      }
    }
  )

  return (
    <Card>
      <CardHeader class="pb-3">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <GitCompare class="h-4 w-4 text-muted-foreground" />
            <CardTitle class="text-sm font-medium">Refactoring Impact</CardTitle>
          </div>
          <Show when={props.operation && props.target}>
            <Button variant="ghost" size="icon" class="h-6 w-6" onClick={() => refetch()} aria-label="Re-analyze impact">
              <RefreshCw class={cn("h-3.5 w-3.5", impact.loading && "animate-spin")} />
            </Button>
          </Show>
        </div>
      </CardHeader>
      <CardContent class="space-y-3">
        <Show when={!props.operation || !props.target}>
          <div class="text-center py-4">
            <GitCompare class="h-6 w-6 text-muted-foreground mx-auto mb-2" />
            <p class="text-xs text-muted-foreground">
              No refactoring operation in progress.
            </p>
            <p class="text-[10px] text-muted-foreground mt-1">
              Impact analysis will appear here when an agent initiates a refactoring.
            </p>
          </div>
        </Show>

        <Show when={impact.loading}>
          <div class="flex items-center gap-2 text-xs text-muted-foreground py-4 justify-center">
            <RefreshCw class="h-3 w-3 animate-spin" />
            Analyzing impact...
          </div>
        </Show>

        <Show when={impact()}>
          {(data) => (
            <>
              {/* Operation Summary */}
              <div class="rounded-md border border-border bg-background p-3 space-y-2">
                <div class="flex items-center justify-between">
                  <div>
                    <span class="text-xs font-medium capitalize">{data().operation}</span>
                    <span class="text-xs text-muted-foreground mx-1">on</span>
                    <span class="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">
                      {data().target}
                    </span>
                  </div>
                  <Badge
                    variant={data().safe ? "outline" : "destructive"}
                    class="text-[10px]"
                  >
                    {data().safe ? (
                      <><CheckCircle class="h-3 w-3 mr-1" /> Safe</>
                    ) : (
                      <><AlertTriangle class="h-3 w-3 mr-1" /> Risky</>
                    )}
                  </Badge>
                </div>

                <div class="flex items-center gap-4 text-xs text-muted-foreground">
                  <span>{data().references} references</span>
                  <span>{data().affectedFiles.length} files affected</span>
                </div>
              </div>

              {/* Warnings */}
              <Show when={data().warnings.length > 0}>
                <div class="space-y-1">
                  <For each={data().warnings}>
                    {(warning) => (
                      <div class="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2">
                        <AlertTriangle class="h-3.5 w-3.5 text-warning shrink-0 mt-0.5" />
                        <span class="text-xs text-warning">{warning}</span>
                      </div>
                    )}
                  </For>
                </div>
              </Show>

              {/* Affected Files */}
              <Show when={data().affectedFiles.length > 0}>
                <div>
                  <button
                    class="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer hover:text-foreground"
                    onClick={() => setShowFiles(!showFiles())}
                  >
                    {showFiles() ? <ChevronDown class="h-3 w-3" /> : <ChevronRight class="h-3 w-3" />}
                    <FileCode class="h-3 w-3" />
                    Affected Files ({data().affectedFiles.length})
                  </button>
                  <Show when={showFiles()}>
                    <div class="mt-1.5 space-y-0.5 pl-5">
                      <For each={data().affectedFiles}>
                        {(file) => (
                          <div class="text-xs font-mono text-muted-foreground truncate">
                            {file}
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </Show>

              {/* Action Buttons */}
              <Show when={props.onApprove || props.onReject}>
                <Separator />
                <div class="flex items-center gap-2 justify-end">
                  <Show when={props.onReject}>
                    <Button variant="outline" size="sm" onClick={props.onReject}>
                      <XCircle class="h-3.5 w-3.5 mr-1" />
                      Reject
                    </Button>
                  </Show>
                  <Show when={props.onApprove}>
                    <Button size="sm" onClick={props.onApprove} disabled={!data().safe}>
                      <CheckCircle class="h-3.5 w-3.5 mr-1" />
                      Approve
                    </Button>
                  </Show>
                </div>
              </Show>
            </>
          )}
        </Show>
      </CardContent>
    </Card>
  )
}

export default RefactoringImpactPreview
