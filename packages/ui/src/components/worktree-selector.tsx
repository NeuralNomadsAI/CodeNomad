import { Select } from "@kobalte/core/select"
import { Dialog } from "@kobalte/core/dialog"
import { For, Show, createMemo, createSignal } from "solid-js"
import { ChevronDown, Copy, Trash2 } from "lucide-solid"
import type { WorktreeDescriptor } from "../../../server/src/api-types"
import { getLogger } from "../lib/logger"
import { copyToClipboard } from "../lib/clipboard"
import { showToastNotification } from "../lib/notifications"
import {
  createWorktree,
  deleteWorktree,
  getParentSessionId,
  getWorktreeSlugForParentSession,
  getWorktrees,
  reloadWorktreeMap,
  reloadWorktrees,
  setWorktreeSlugForParentSession,
} from "../stores/worktrees"
import { sessions } from "../stores/sessions"

const log = getLogger("session")

type WorktreeOption =
  | { kind: "action"; key: "__create__"; label: string }
  | { kind: "worktree"; key: string; slug: string; directory: string; raw: WorktreeDescriptor }

const CREATE_OPTION: WorktreeOption = { kind: "action", key: "__create__", label: "+ Create worktree" }

function preventSelectPress(event: PointerEvent | MouseEvent) {
  // Prevent Select.Item from treating this as a selection.
  // We intentionally prevent default to stop Kobalte's internal press handling.
  event.preventDefault()
  event.stopImmediatePropagation?.()
  event.stopPropagation()
}

function normalizePath(input: string): string {
  return (input ?? "").replace(/\\/g, "/").replace(/\/+$/, "")
}

function relativePath(fromDir: string, toDir: string): string {
  const from = normalizePath(fromDir)
  const to = normalizePath(toDir)
  if (!from || !to) return to || from || ""
  if (from === to) return "."

  const fromParts = from.split("/").filter(Boolean)
  const toParts = to.split("/").filter(Boolean)

  let i = 0
  while (i < fromParts.length && i < toParts.length) {
    const a = fromParts[i]
    const b = toParts[i]
    if (!a || !b) break
    if (a.toLowerCase() !== b.toLowerCase()) break
    i++
  }

  const up = fromParts.length - i
  const down = toParts.slice(i)
  const relParts: string[] = []
  for (let j = 0; j < up; j++) relParts.push("..")
  relParts.push(...down)
  return relParts.join("/") || "."
}

interface WorktreeSelectorProps {
  instanceId: string
  sessionId: string
}

export default function WorktreeSelector(props: WorktreeSelectorProps) {
  const [isOpen, setIsOpen] = createSignal(false)
  const [createOpen, setCreateOpen] = createSignal(false)
  const [createSlug, setCreateSlug] = createSignal("")
  const [isCreating, setIsCreating] = createSignal(false)

  const [deleteOpen, setDeleteOpen] = createSignal(false)
  const [deleteTarget, setDeleteTarget] = createSignal<WorktreeOption & { kind: "worktree" } | null>(null)
  const [forceDelete, setForceDelete] = createSignal(false)
  const [isDeleting, setIsDeleting] = createSignal(false)

  const session = createMemo(() => sessions().get(props.instanceId)?.get(props.sessionId))
  const isChildSession = createMemo(() => Boolean(session()?.parentId))
  const parentId = createMemo(() => getParentSessionId(props.instanceId, props.sessionId))
  const currentSlug = createMemo(() => getWorktreeSlugForParentSession(props.instanceId, parentId()))

  const worktreeOptions = createMemo<WorktreeOption[]>(() => {
    const list = getWorktrees(props.instanceId)
    const mapped: WorktreeOption[] = list.map((wt) => ({
      kind: "worktree",
      key: wt.slug,
      slug: wt.slug,
      directory: wt.directory,
      raw: wt,
    }))
    return [CREATE_OPTION, ...mapped]
  })

  const selectedOption = createMemo<WorktreeOption | undefined>(() => {
    const slug = currentSlug()
    const match = worktreeOptions().find((opt) => opt.kind === "worktree" && opt.slug === slug)
    if (match) return match
    // Fallback to root if mapped slug is missing.
    return worktreeOptions().find((opt) => opt.kind === "worktree" && opt.slug === "root")
  })

  const openDeleteDialog = (opt: WorktreeOption & { kind: "worktree" }) => {
    if (opt.slug === "root") return
    setForceDelete(false)
    setDeleteTarget(opt)
    setDeleteOpen(true)
  }

  const repoRoot = createMemo(() => {
    const list = getWorktrees(props.instanceId)
    return list.find((wt) => wt.slug === "root")?.directory ?? ""
  })

  const displayPathFor = (directory: string) => {
    const base = repoRoot()
    if (!base) return directory
    return relativePath(base, directory)
  }

  const handleCopyPath = async (directory: string) => {
    try {
      const ok = await copyToClipboard(directory)
      showToastNotification({ message: ok ? "Copied worktree path" : "Failed to copy path", variant: ok ? "success" : "error" })
    } catch (error) {
      log.error("Failed to copy worktree path", error)
      showToastNotification({ message: "Failed to copy path", variant: "error" })
    }
  }

  const handleChange = async (value: WorktreeOption | null) => {
    if (!value) return
    if (value.kind === "action") {
      setIsOpen(false)
      setCreateSlug("")
      setCreateOpen(true)
      return
    }
    await setWorktreeSlugForParentSession(props.instanceId, parentId(), value.slug)
  }

  return (
    <div class="sidebar-selector">
      <Select<WorktreeOption>
        open={isOpen()}
        onOpenChange={setIsOpen}
        value={selectedOption() ?? null}
        onChange={(value) => {
          void handleChange(value).catch((error) => log.warn("Failed to change worktree", error))
        }}
        options={worktreeOptions()}
        optionValue="key"
        optionTextValue={(opt) => (opt.kind === "action" ? opt.label : opt.slug)}
        placeholder="Worktree"
        disabled={isChildSession()}
        itemComponent={(itemProps) => {
          const opt = itemProps.item.rawValue
          if (opt.kind === "action") {
            return (
              <Select.Item item={itemProps.item} class="selector-option worktree-selector-item">
                <div class="selector-option-content w-full">
                  <Select.ItemLabel class="selector-option-label">{opt.label}</Select.ItemLabel>
                  <Select.ItemDescription class="selector-option-description">New from current branch</Select.ItemDescription>
                </div>
              </Select.Item>
            )
          }

          return (
            <Select.Item item={itemProps.item} class="selector-option worktree-selector-item">
              <div class="flex flex-col gap-1 flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <Select.ItemLabel class="selector-option-label flex-1 min-w-0 truncate">
                    {opt.slug === "root" ? "root" : opt.slug}
                  </Select.ItemLabel>
                  <Show when={opt.slug !== "root"}>
                    <button
                      type="button"
                      class="session-item-close opacity-80 hover:opacity-100 hover:bg-surface-hover"
                      aria-label="Delete worktree"
                      title="Delete worktree"
                      onPointerDown={(event) => {
                        preventSelectPress(event)
                        setIsOpen(false)
                        openDeleteDialog(opt)
                      }}
                      onPointerUp={preventSelectPress}
                      onMouseDown={preventSelectPress}
                      onMouseUp={preventSelectPress}
                      onClick={preventSelectPress}
                    >
                      <Trash2 class="w-3 h-3" />
                    </button>
                  </Show>
                </div>
                <div class="flex items-center gap-2 min-w-0">
                  <span
                    class="selector-option-description flex-1 min-w-0 truncate font-mono"
                    title={opt.directory}
                  >
                    {displayPathFor(opt.directory)}
                  </span>
                  <button
                    type="button"
                    class="session-item-close opacity-80 hover:opacity-100 hover:bg-surface-hover"
                    aria-label="Copy path"
                    title="Copy path"
                    onPointerDown={(event) => {
                      preventSelectPress(event)
                      void (async () => {
                        await handleCopyPath(opt.directory)
                        setIsOpen(false)
                      })()
                    }}
                    onPointerUp={preventSelectPress}
                    onMouseDown={preventSelectPress}
                    onMouseUp={preventSelectPress}
                    onClick={preventSelectPress}
                  >
                    <Copy class="w-3 h-3" />
                  </button>
                </div>
              </div>
            </Select.Item>
          )
        }}
      >
        <Select.Trigger class="selector-trigger">
          <div class="flex-1 min-w-0">
            <Select.Value<WorktreeOption>>
              {(state) => {
                const value = state.selectedOption()
                const label = value && value.kind === "worktree" ? (value.slug === "root" ? "root" : value.slug) : "root"
                return (
                  <div class="selector-trigger-label selector-trigger-label--stacked">
                    <span class="selector-trigger-primary selector-trigger-primary--align-left">Worktree: {label}</span>
                  </div>
                )
              }}
            </Select.Value>
          </div>
          <Select.Icon class="selector-trigger-icon">
            <ChevronDown class="w-3 h-3" />
          </Select.Icon>
        </Select.Trigger>

        <Select.Portal>
          <Select.Content class="selector-popover max-h-80 overflow-auto p-1">
            <Select.Listbox class="selector-listbox" />
          </Select.Content>
        </Select.Portal>
      </Select>

      <Dialog open={createOpen()} onOpenChange={(open) => !open && setCreateOpen(false)}>
        <Dialog.Portal>
          <Dialog.Overlay class="modal-overlay" />
          <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
            <Dialog.Content class="modal-surface w-full max-w-md p-6 flex flex-col gap-5">
              <div>
                <Dialog.Title class="text-xl font-semibold text-primary">Create worktree</Dialog.Title>
                <Dialog.Description class="text-sm text-secondary mt-2">Creates a git worktree</Dialog.Description>
              </div>

              <div class="space-y-2">
                <label class="text-xs font-medium text-muted uppercase tracking-wide">Name</label>
                <input
                  class="form-input w-full"
                  value={createSlug()}
                  onInput={(e) => setCreateSlug(e.currentTarget.value)}
                  placeholder="worktree-name"
                  disabled={isCreating()}
                  spellcheck={false}
                  autocapitalize="off"
                  autocomplete="off"
                />
              </div>

              <div class="flex justify-end gap-2">
                <button
                  type="button"
                  class="selector-button selector-button-secondary"
                  onClick={() => setCreateOpen(false)}
                  disabled={isCreating()}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class="selector-button selector-button-primary"
                  disabled={
                    isCreating() ||
                    !createSlug().trim() ||
                    createSlug().trim() === "root" ||
                    /[\x00-\x1F\x7F]/.test(createSlug())
                  }
                  onClick={() => {
                    const slug = createSlug().trim()
                    void (async () => {
                      setIsCreating(true)
                      await createWorktree(props.instanceId, slug)
                      await reloadWorktrees(props.instanceId)
                      await setWorktreeSlugForParentSession(props.instanceId, parentId(), slug)
                      setCreateOpen(false)
                      showToastNotification({ message: `Created worktree ${slug}`, variant: "success" })
                    })()
                      .catch((error) => {
                        log.warn("Failed to create worktree", error)
                        showToastNotification({
                          message: error instanceof Error ? error.message : "Failed to create worktree",
                          variant: "error",
                        })
                      })
                      .finally(() => {
                        setIsCreating(false)
                      })
                  }}
                >
                  {isCreating() ? "Creating..." : "Create"}
                </button>
              </div>
            </Dialog.Content>
          </div>
        </Dialog.Portal>
      </Dialog>

      <Dialog open={deleteOpen()} onOpenChange={(open) => !open && setDeleteOpen(false)}>
        <Dialog.Portal>
          <Dialog.Overlay class="modal-overlay" />
          <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
            <Dialog.Content class="modal-surface w-full max-w-md p-6 flex flex-col gap-5">
              <div>
                <Dialog.Title class="text-xl font-semibold text-primary">Delete worktree</Dialog.Title>
                <Dialog.Description class="text-sm text-secondary mt-2">Removes the git worktree checkout directory for this branch.</Dialog.Description>
              </div>

              <Show when={deleteTarget()}>
                {(target) => (
                  <div class="rounded-lg border border-base bg-surface-secondary p-4">
                    <p class="text-xs font-medium text-muted uppercase tracking-wide mb-1">Worktree</p>
                    <p class="text-sm font-mono text-primary break-all">{target().slug}</p>
                    <p class="text-[11px] text-secondary mt-2 break-all font-mono">{target().directory}</p>
                  </div>
                )}
              </Show>

              <label class="flex items-center gap-2 text-sm text-secondary">
                <input
                  type="checkbox"
                  checked={forceDelete()}
                  onChange={(e) => setForceDelete(e.currentTarget.checked)}
                  disabled={isDeleting()}
                />
                Force delete (discard local changes)
              </label>

              <div class="flex justify-end gap-2">
                <button
                  type="button"
                  class="selector-button selector-button-secondary"
                  onClick={() => setDeleteOpen(false)}
                  disabled={isDeleting()}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class="selector-button selector-button-primary"
                  disabled={isDeleting() || !deleteTarget()}
                  onClick={() => {
                    const target = deleteTarget()
                    if (!target) {
                      setDeleteOpen(false)
                      return
                    }

                    void (async () => {
                      setIsDeleting(true)
                      await deleteWorktree(props.instanceId, target.slug, { force: forceDelete() })
                      await reloadWorktrees(props.instanceId)
                      await reloadWorktreeMap(props.instanceId)

                      if (currentSlug() === target.slug) {
                        await setWorktreeSlugForParentSession(props.instanceId, parentId(), "root")
                      }

                      setDeleteOpen(false)
                      showToastNotification({ message: `Deleted worktree ${target.slug}`, variant: "success" })
                    })()
                      .catch((error) => {
                        log.warn("Failed to delete worktree", error)
                        showToastNotification({
                          message: error instanceof Error ? error.message : "Failed to delete worktree",
                          variant: "error",
                        })
                      })
                      .finally(() => {
                        setIsDeleting(false)
                      })
                  }}
                >
                  {isDeleting() ? "Deleting..." : "Delete"}
                </button>
              </div>
            </Dialog.Content>
          </div>
        </Dialog.Portal>
      </Dialog>
    </div>
  )
}
