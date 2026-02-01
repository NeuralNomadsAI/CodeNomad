import { type JSX, splitProps } from "solid-js"
import { DropdownMenu as KobalteDropdownMenu } from "@kobalte/core/dropdown-menu"
import { cn } from "../../lib/cn"

const DropdownMenu = KobalteDropdownMenu
const DropdownMenuTrigger = KobalteDropdownMenu.Trigger
const DropdownMenuGroup = KobalteDropdownMenu.Group
const DropdownMenuSub = KobalteDropdownMenu.Sub

function DropdownMenuContent(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ["class", "children"])
  return (
    <KobalteDropdownMenu.Portal>
      <KobalteDropdownMenu.Content
        class={cn(
          "z-50 min-w-[8rem] overflow-hidden rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg data-[expanded]:animate-in data-[expanded]:fade-in-0 data-[expanded]:zoom-in-95 data-[closed]:animate-out data-[closed]:fade-out-0 data-[closed]:zoom-out-95",
          local.class
        )}
        {...rest}
      >
        {local.children}
      </KobalteDropdownMenu.Content>
    </KobalteDropdownMenu.Portal>
  )
}

function DropdownMenuItem(props: { class?: string; children?: JSX.Element; disabled?: boolean; onSelect?: () => void }) {
  const [local, rest] = splitProps(props, ["class", "children"])
  return (
    <KobalteDropdownMenu.Item
      class={cn(
        "relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        local.class
      )}
      {...(rest as any)}
    >
      {local.children}
    </KobalteDropdownMenu.Item>
  )
}

function DropdownMenuCheckboxItem(props: any) {
  const [local, rest] = splitProps(props, ["class", "children", "checked"])
  return (
    <KobalteDropdownMenu.CheckboxItem
      class={cn(
        "relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        local.class
      )}
      checked={local.checked}
      {...rest}
    >
      <span class="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <KobalteDropdownMenu.ItemIndicator>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </KobalteDropdownMenu.ItemIndicator>
      </span>
      {local.children}
    </KobalteDropdownMenu.CheckboxItem>
  )
}

function DropdownMenuLabel(props: { class?: string; children?: JSX.Element; inset?: boolean }) {
  const [local] = splitProps(props, ["class", "children", "inset"])
  return (
    <KobalteDropdownMenu.GroupLabel
      class={cn("px-2 py-1.5 text-sm font-semibold", local.inset && "pl-8", local.class)}
    >
      {local.children}
    </KobalteDropdownMenu.GroupLabel>
  )
}

function DropdownMenuSeparator(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ["class"])
  return (
    <KobalteDropdownMenu.Separator
      class={cn("-mx-1 my-1 h-px bg-border", local.class)}
      {...rest}
    />
  )
}

function DropdownMenuShortcut(props: JSX.HTMLAttributes<HTMLSpanElement>) {
  const [local, rest] = splitProps(props, ["class", "children"])
  return (
    <span class={cn("ml-auto text-xs tracking-widest opacity-60", local.class)} {...rest}>
      {local.children}
    </span>
  )
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuGroup,
  DropdownMenuSub,
}
