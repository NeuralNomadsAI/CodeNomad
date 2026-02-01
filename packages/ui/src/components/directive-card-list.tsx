import { Component, For, Show, createSignal, createMemo } from "solid-js"
import { LayoutGrid, FileText, Plus, FileQuestion, Search, X, ChevronDown, ChevronRight } from "lucide-solid"
import { cn } from "../lib/cn"
import { Button } from "./ui"
import DirectiveCard from "./directive-card"
import type { DirectiveSection, ParsedDirective } from "../lib/directive-parser"
import { getSectionColor } from "../lib/directive-parser"

export type ViewMode = "cards" | "raw"

interface DirectiveCardListProps {
  sections: DirectiveSection[]
  rawContent: string
  readOnly?: boolean
  onChange?: (sections: DirectiveSection[]) => void
  onRawChange?: (content: string) => void
  onAddToSection?: (sectionTitle: string) => void
  showViewToggle?: boolean
  showSearch?: boolean
  viewMode?: ViewMode
  onViewModeChange?: (mode: ViewMode) => void
}

const DirectiveCardList: Component<DirectiveCardListProps> = (props) => {
  // Internal view mode if not controlled externally
  const [internalViewMode, setInternalViewMode] = createSignal<ViewMode>("cards")
  const [searchQuery, setSearchQuery] = createSignal("")
  const [collapsedSections, setCollapsedSections] = createSignal<Set<string>>(new Set())

  const viewMode = () => props.viewMode ?? internalViewMode()
  const setViewMode = (mode: ViewMode) => {
    if (props.onViewModeChange) {
      props.onViewModeChange(mode)
    } else {
      setInternalViewMode(mode)
    }
  }

  // Filter sections based on search query
  const filteredSections = createMemo(() => {
    const query = searchQuery().toLowerCase().trim()
    if (!query) return props.sections

    return props.sections
      .map(section => ({
        ...section,
        directives: section.directives.filter(d =>
          d.text.toLowerCase().includes(query) ||
          section.title.toLowerCase().includes(query)
        ),
      }))
      .filter(section => section.directives.length > 0)
  })

  const totalDirectives = createMemo(() =>
    props.sections.reduce((sum, s) => sum + s.directives.length, 0)
  )

  const filteredCount = createMemo(() =>
    filteredSections().reduce((sum, s) => sum + s.directives.length, 0)
  )

  const toggleSection = (title: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev)
      if (next.has(title)) {
        next.delete(title)
      } else {
        next.add(title)
      }
      return next
    })
  }

  const isSectionCollapsed = (title: string) => collapsedSections().has(title)

  const expandAll = () => setCollapsedSections(new Set())
  const collapseAll = () => setCollapsedSections(new Set(props.sections.map(s => s.title)))

  const handleEdit = (id: string, newText: string) => {
    if (!props.onChange) return

    const updatedSections = props.sections.map(section => ({
      ...section,
      directives: section.directives.map(d =>
        d.id === id ? { ...d, text: newText, original: `- ${newText}` } : d
      ),
    }))
    props.onChange(updatedSections)
  }

  const handleDelete = (id: string) => {
    if (!props.onChange) return

    const updatedSections = props.sections
      .map(section => ({
        ...section,
        directives: section.directives.filter(d => d.id !== id),
      }))
      .filter(section => section.directives.length > 0)
    props.onChange(updatedSections)
  }

  return (
    <div>
      {/* Toolbar: View Toggle + Search */}
      <div class={cn("flex items-center gap-4 flex-wrap mb-4")}>
        <Show when={props.showViewToggle !== false}>
          <div class={cn("flex items-center rounded-lg overflow-hidden bg-secondary border border-border")}>
            <button
              type="button"
              class={cn(
                "flex items-center gap-2 px-3 py-1.5 text-sm font-medium transition-colors",
                viewMode() === "cards"
                  ? "bg-info text-white"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent"
              )}
              onClick={() => setViewMode("cards")}
            >
              <LayoutGrid class="w-4 h-4" />
              <span>Cards</span>
            </button>
            <button
              type="button"
              class={cn(
                "flex items-center gap-2 px-3 py-1.5 text-sm font-medium transition-colors",
                viewMode() === "raw"
                  ? "bg-info text-white"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent"
              )}
              onClick={() => setViewMode("raw")}
            >
              <FileText class="w-4 h-4" />
              <span>Raw</span>
            </button>
          </div>
        </Show>

        {/* Search - only show in card view */}
        <Show when={viewMode() === "cards" && props.showSearch !== false && totalDirectives() > 0}>
          <div class={cn("flex items-center gap-2 px-3 py-1.5 rounded-lg flex-1 max-w-xs bg-secondary border border-border")}>
            <Search class="w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              class={cn("flex-1 bg-transparent text-sm outline-none text-foreground placeholder:text-muted-foreground")}
              placeholder="Search directives..."
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
            />
            <Show when={searchQuery()}>
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                class={cn("p-1 rounded transition-colors text-muted-foreground hover:text-foreground hover:bg-accent")}
              >
                <X class="w-3 h-3" />
              </button>
            </Show>
          </div>
        </Show>

        {/* Expand/Collapse All - only show in card view with multiple sections */}
        <Show when={viewMode() === "cards" && filteredSections().length > 1}>
          <div class={cn("flex items-center gap-2")}>
            <button
              type="button"
              onClick={expandAll}
              class={cn("px-2 py-1 text-xs rounded transition-colors text-muted-foreground hover:text-foreground hover:bg-secondary")}
            >
              Expand All
            </button>
            <button
              type="button"
              onClick={collapseAll}
              class={cn("px-2 py-1 text-xs rounded transition-colors text-muted-foreground hover:text-foreground hover:bg-secondary")}
            >
              Collapse All
            </button>
          </div>
        </Show>
      </div>

      {/* Search results count */}
      <Show when={searchQuery() && viewMode() === "cards"}>
        <div class={cn("text-sm mb-3 text-muted-foreground")}>
          Found {filteredCount()} {filteredCount() === 1 ? "directive" : "directives"}
          {filteredCount() !== totalDirectives() && ` (of ${totalDirectives()} total)`}
        </div>
      </Show>

      {/* Card View */}
      <Show when={viewMode() === "cards"}>
        <Show when={props.sections.length === 0}>
          <div class={cn("flex flex-col items-center justify-center py-12 text-center text-muted-foreground")}>
            <FileQuestion class={cn("w-12 h-12 mb-4 opacity-30")} />
            <p class={cn("text-sm font-medium mb-1 text-foreground")}>No directives found</p>
            <p class={cn("text-xs max-w-sm mb-4 text-muted-foreground")}>
              {props.readOnly
                ? "This document has no directives configured."
                : "Add your first directive to get started."}
            </p>
          </div>
        </Show>

        <Show when={props.sections.length > 0 && filteredSections().length === 0}>
          <div class={cn("flex flex-col items-center justify-center py-12 text-center text-muted-foreground")}>
            <Search class={cn("w-12 h-12 mb-4 opacity-30")} />
            <p class={cn("text-sm font-medium mb-1 text-foreground")}>No matches found</p>
            <p class={cn("text-xs max-w-sm mb-4 text-muted-foreground")}>
              No directives match "{searchQuery()}". Try a different search term.
            </p>
            <button
              type="button"
              class={cn(
                "inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors",
                "bg-secondary border border-dashed border-border text-muted-foreground",
                "hover:border-info hover:text-info"
              )}
              onClick={() => setSearchQuery("")}
            >
              Clear search
            </button>
          </div>
        </Show>

        <Show when={filteredSections().length > 0}>
          <div class="flex flex-col gap-4">
            <For each={filteredSections()}>
              {(section) => {
                const isCollapsed = () => isSectionCollapsed(section.title)
                return (
                  <div class={cn("rounded-lg overflow-hidden bg-secondary border border-border")}>
                    <button
                      type="button"
                      class={cn(
                        "flex items-center justify-between px-4 py-3 w-full cursor-pointer transition-colors",
                        "bg-background border-b border-border text-left",
                        "hover:bg-accent"
                      )}
                      onClick={() => toggleSection(section.title)}
                    >
                      <div class={cn("flex items-center gap-2")}>
                        <span class={cn("flex-shrink-0 transition-transform text-muted-foreground")}>
                          {isCollapsed() ? (
                            <ChevronRight class="w-4 h-4" />
                          ) : (
                            <ChevronDown class="w-4 h-4" />
                          )}
                        </span>
                        <div
                          class={cn("w-1 h-5 rounded-full")}
                          data-color={getSectionColor(section.title)}
                        />
                        <span class={cn("font-semibold text-sm text-foreground")}>{section.title}</span>
                        <span class={cn("text-xs px-2 py-0.5 rounded-full bg-secondary text-muted-foreground")}>
                          {section.directives.length}
                        </span>
                      </div>
                      <Show when={!props.readOnly && props.onAddToSection}>
                        <button
                          type="button"
                          class={cn("p-1.5 rounded transition-colors text-muted-foreground hover:text-info hover:bg-secondary")}
                          onClick={(e) => {
                            e.stopPropagation()
                            props.onAddToSection?.(section.title)
                          }}
                          title={`Add directive to ${section.title}`}
                        >
                          <Plus class="w-4 h-4" />
                        </button>
                      </Show>
                    </button>
                    <Show when={!isCollapsed()}>
                      <div class={cn("p-4 flex flex-col gap-3")}>
                        <For each={section.directives}>
                          {(directive) => (
                            <DirectiveCard
                              directive={directive}
                              readOnly={props.readOnly}
                              onEdit={handleEdit}
                              onDelete={handleDelete}
                            />
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </Show>

      {/* Raw Markdown View */}
      <Show when={viewMode() === "raw"}>
        <Show when={props.readOnly}>
          <pre class={cn(
            "w-full rounded-lg p-4 text-sm overflow-auto min-h-[200px] max-h-[500px]",
            "bg-secondary border border-border text-muted-foreground",
            "font-mono leading-relaxed whitespace-pre-wrap break-all"
          )}>{props.rawContent || "No content"}</pre>
        </Show>
        <Show when={!props.readOnly}>
          <textarea
            class={cn(
              "w-full rounded-lg p-4 text-sm resize-none min-h-[400px]",
              "bg-secondary border border-border text-foreground",
              "font-mono leading-relaxed",
              "placeholder:text-muted-foreground",
              "focus:outline-none focus:border-info"
            )}
            value={props.rawContent}
            onInput={(e) => props.onRawChange?.(e.currentTarget.value)}
            placeholder="# Section Title

- Add your directives here
- One directive per line"
          />
        </Show>
      </Show>
    </div>
  )
}

export default DirectiveCardList
