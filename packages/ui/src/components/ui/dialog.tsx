import { type JSX, splitProps, Show } from "solid-js"
import { Dialog as KobalteDialog } from "@kobalte/core/dialog"
import { cn } from "../../lib/cn"

const Dialog = KobalteDialog

function DialogTrigger(props: JSX.HTMLAttributes<HTMLButtonElement> & { as?: any }) {
  return <KobalteDialog.Trigger {...props} />
}

function DialogPortal(props: { children: JSX.Element }) {
  return <KobalteDialog.Portal>{props.children}</KobalteDialog.Portal>
}

function DialogOverlay(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ["class"])
  return (
    <KobalteDialog.Overlay
      class={cn(
        "fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[expanded]:animate-in data-[expanded]:fade-in-0 data-[closed]:animate-out data-[closed]:fade-out-0",
        local.class
      )}
      {...rest}
    />
  )
}

interface DialogContentProps extends JSX.HTMLAttributes<HTMLDivElement> {
  showClose?: boolean
}

function DialogContent(props: DialogContentProps) {
  const [local, rest] = splitProps(props, ["class", "children", "showClose"])

  return (
    <DialogPortal>
      <DialogOverlay />
      <KobalteDialog.Content
        class={cn(
          "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-2xl duration-200 data-[expanded]:animate-in data-[expanded]:fade-in-0 data-[expanded]:zoom-in-95 data-[expanded]:slide-in-from-left-1/2 data-[expanded]:slide-in-from-top-[48%] data-[closed]:animate-out data-[closed]:fade-out-0 data-[closed]:zoom-out-95 data-[closed]:slide-out-to-left-1/2 data-[closed]:slide-out-to-top-[48%] rounded-xl",
          local.class
        )}
        {...rest}
      >
        {local.children}
        <Show when={local.showClose !== false}>
          <KobalteDialog.CloseButton class="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
            <span class="sr-only">Close</span>
          </KobalteDialog.CloseButton>
        </Show>
      </KobalteDialog.Content>
    </DialogPortal>
  )
}

function DialogHeader(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ["class", "children"])
  return (
    <div
      class={cn("flex flex-col space-y-1.5 text-center sm:text-left", local.class)}
      {...rest}
    >
      {local.children}
    </div>
  )
}

function DialogFooter(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ["class", "children"])
  return (
    <div
      class={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", local.class)}
      {...rest}
    >
      {local.children}
    </div>
  )
}

function DialogTitle(props: JSX.HTMLAttributes<HTMLHeadingElement>) {
  const [local, rest] = splitProps(props, ["class", "children"])
  return (
    <KobalteDialog.Title
      class={cn("text-lg font-semibold leading-none tracking-tight", local.class)}
      {...rest}
    >
      {local.children}
    </KobalteDialog.Title>
  )
}

function DialogDescription(props: JSX.HTMLAttributes<HTMLParagraphElement>) {
  const [local, rest] = splitProps(props, ["class", "children"])
  return (
    <KobalteDialog.Description
      class={cn("text-sm text-muted-foreground", local.class)}
      {...rest}
    >
      {local.children}
    </KobalteDialog.Description>
  )
}

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
