import { Component, For, Show, createSignal, createMemo } from "solid-js"
import {
  ListTree,
  Wrench,
  TestTube,
  Eye,
  Code,
  FileSearch,
  PenLine,
} from "lucide-solid"
import { cn } from "../lib/cn"

interface ModeChip {
  id: string
  label: string
  icon: Component<{ class?: string }>
  keywords: string[]
  color: string
}

const MODE_DEFINITIONS: ModeChip[] = [
  {
    id: "plan",
    label: "Plan",
    icon: (p) => <ListTree class={p.class} />,
    keywords: ["plan", "architect", "design", "strategy", "approach"],
    color: "bg-purple-500/10 text-purple-500 border-purple-500/30",
  },
  {
    id: "refactor",
    label: "Refactor",
    icon: (p) => <Wrench class={p.class} />,
    keywords: ["refactor", "rename", "extract", "inline", "restructure"],
    color: "bg-info/10 text-info border-info/30",
  },
  {
    id: "test",
    label: "Test",
    icon: (p) => <TestTube class={p.class} />,
    keywords: ["test", "spec", "assert", "coverage", "e2e", "unit"],
    color: "bg-success/10 text-success border-success/30",
  },
  {
    id: "review",
    label: "Review",
    icon: (p) => <Eye class={p.class} />,
    keywords: ["review", "audit", "check", "inspect", "verify"],
    color: "bg-warning/10 text-warning border-warning/30",
  },
  {
    id: "implement",
    label: "Implement",
    icon: (p) => <Code class={p.class} />,
    keywords: ["implement", "build", "create", "add", "feature"],
    color: "bg-orange-500/10 text-orange-500 border-orange-500/30",
  },
  {
    id: "investigate",
    label: "Investigate",
    icon: (p) => <FileSearch class={p.class} />,
    keywords: ["investigate", "debug", "find", "trace", "diagnose"],
    color: "bg-cyan-500/10 text-cyan-500 border-cyan-500/30",
  },
  {
    id: "document",
    label: "Document",
    icon: (p) => <PenLine class={p.class} />,
    keywords: ["document", "readme", "docs", "explain", "describe"],
    color: "bg-pink-500/10 text-pink-500 border-pink-500/30",
  },
]

interface ModeChipsProps {
  inputText: string
  onModeActivate?: (modeId: string) => void
  activeMode?: string | null
}

const ModeChips: Component<ModeChipsProps> = (props) => {
  const detectedModes = createMemo(() => {
    const text = props.inputText.toLowerCase().trim()
    if (!text) return []

    return MODE_DEFINITIONS.filter((mode) =>
      mode.keywords.some((kw) => text.includes(kw))
    ).slice(0, 3)
  })

  const hasDetections = createMemo(() => detectedModes().length > 0)

  return (
    <Show when={hasDetections()}>
      <div class="flex items-center gap-1 px-1 pb-1">
        <For each={detectedModes()}>
          {(mode) => {
            const isActive = () => props.activeMode === mode.id
            const Icon = mode.icon

            return (
              <button
                class={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-all",
                  mode.color,
                  isActive() && "ring-1 ring-primary shadow-sm",
                  "hover:opacity-80 cursor-pointer"
                )}
                onClick={() => props.onModeActivate?.(mode.id)}
              >
                <Icon class="h-3 w-3" />
                {mode.label}
              </button>
            )
          }}
        </For>
      </div>
    </Show>
  )
}

export default ModeChips
