import { type JSX, splitProps } from "solid-js"
import { Dialog as KobalteDialog } from "@kobalte/core/dialog"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../../lib/cn"

const Sheet = KobalteDialog

const SheetTrigger = KobalteDialog.Trigger

function SheetPortal(props: { children: JSX.Element }) {
  return <KobalteDialog.Portal>{props.children}</KobalteDialog.Portal>
}

function SheetOverlay(props: JSX.HTMLAttributes<HTMLDivElement>) {
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

const sheetVariants = cva(
  "fixed z-50 gap-4 bg-background p-6 shadow-2xl transition ease-in-out data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:duration-200 data-[expanded]:duration-300",
  {
    variants: {
      side: {
        top: "inset-x-0 top-0 border-b data-[closed]:slide-out-to-top data-[expanded]:slide-in-from-top",
        bottom:
          "inset-x-0 bottom-0 border-t data-[closed]:slide-out-to-bottom data-[expanded]:slide-in-from-bottom",
        left: "inset-y-0 left-0 h-full w-3/4 border-r data-[closed]:slide-out-to-left data-[expanded]:slide-in-from-left sm:max-w-sm",
        right:
          "inset-y-0 right-0 h-full w-3/4 border-l data-[closed]:slide-out-to-right data-[expanded]:slide-in-from-right sm:max-w-sm",
      },
    },
    defaultVariants: {
      side: "right",
    },
  }
)

interface SheetContentProps extends JSX.HTMLAttributes<HTMLDivElement>, VariantProps<typeof sheetVariants> {}

function SheetContent(props: SheetContentProps) {
  const [local, rest] = splitProps(props, ["class", "children", "side"])

  return (
    <SheetPortal>
      <SheetOverlay />
      <KobalteDialog.Content
        class={cn(sheetVariants({ side: local.side }), local.class)}
        {...rest}
      >
        {local.children}
        <KobalteDialog.CloseButton class="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
          <span class="sr-only">Close</span>
        </KobalteDialog.CloseButton>
      </KobalteDialog.Content>
    </SheetPortal>
  )
}

function SheetHeader(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ["class", "children"])
  return (
    <div
      class={cn("flex flex-col space-y-2 text-center sm:text-left", local.class)}
      {...rest}
    >
      {local.children}
    </div>
  )
}

function SheetFooter(props: JSX.HTMLAttributes<HTMLDivElement>) {
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

function SheetTitle(props: JSX.HTMLAttributes<HTMLHeadingElement>) {
  const [local, rest] = splitProps(props, ["class", "children"])
  return (
    <KobalteDialog.Title
      class={cn("text-lg font-semibold text-foreground", local.class)}
      {...rest}
    >
      {local.children}
    </KobalteDialog.Title>
  )
}

function SheetDescription(props: JSX.HTMLAttributes<HTMLParagraphElement>) {
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
  Sheet,
  SheetTrigger,
  SheetPortal,
  SheetOverlay,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
