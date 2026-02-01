import { type JSX, splitProps } from "solid-js"
import { Select as KobalteSelect } from "@kobalte/core/select"
import { cn } from "../../lib/cn"

const Select = KobalteSelect

function SelectTrigger(props: JSX.HTMLAttributes<HTMLButtonElement>) {
  const [local, rest] = splitProps(props, ["class", "children"])
  return (
    <KobalteSelect.Trigger
      class={cn(
        "flex h-9 w-full items-center justify-between whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1",
        local.class
      )}
      {...rest}
    >
      {local.children}
      <KobalteSelect.Icon class="flex h-3.5 w-3.5 items-center justify-center">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </KobalteSelect.Icon>
    </KobalteSelect.Trigger>
  )
}

function SelectValue(props: any) {
  return <KobalteSelect.Value {...props} />
}

function SelectContent(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ["class", "children"])
  return (
    <KobalteSelect.Portal>
      <KobalteSelect.Content
        class={cn(
          "relative z-50 max-h-96 min-w-[8rem] overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg data-[expanded]:animate-in data-[expanded]:fade-in-0 data-[expanded]:zoom-in-95 data-[closed]:animate-out data-[closed]:fade-out-0 data-[closed]:zoom-out-95",
          local.class
        )}
        {...rest}
      >
        <KobalteSelect.Listbox class="p-1" />
        {local.children}
      </KobalteSelect.Content>
    </KobalteSelect.Portal>
  )
}

function SelectItem(props: { class?: string; children?: any; item: any; disabled?: boolean }) {
  const [local, rest] = splitProps(props, ["class", "children"])
  return (
    <KobalteSelect.Item
      class={cn(
        "relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-2 pr-8 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        local.class
      )}
      {...(rest as any)}
    >
      <span class="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
        <KobalteSelect.ItemIndicator>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </KobalteSelect.ItemIndicator>
      </span>
      <KobalteSelect.ItemLabel>{local.children}</KobalteSelect.ItemLabel>
    </KobalteSelect.Item>
  )
}

export { Select, SelectTrigger, SelectValue, SelectContent, SelectItem }
