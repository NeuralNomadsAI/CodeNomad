import { type JSX, splitProps } from "solid-js"
import { AlertDialog as KobalteAlertDialog } from "@kobalte/core/alert-dialog"
import { cn } from "../../lib/cn"
import { buttonVariants } from "./button"

const AlertDialog = KobalteAlertDialog

function AlertDialogTrigger(props: JSX.HTMLAttributes<HTMLButtonElement> & { as?: any }) {
  return <KobalteAlertDialog.Trigger {...props} />
}

function AlertDialogPortal(props: { children: JSX.Element }) {
  return <KobalteAlertDialog.Portal>{props.children}</KobalteAlertDialog.Portal>
}

function AlertDialogOverlay(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ["class"])
  return (
    <KobalteAlertDialog.Overlay
      class={cn(
        "fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[expanded]:animate-in data-[expanded]:fade-in-0 data-[closed]:animate-out data-[closed]:fade-out-0",
        local.class
      )}
      {...rest}
    />
  )
}

function AlertDialogContent(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ["class", "children"])
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <KobalteAlertDialog.Content
        class={cn(
          "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border border-border bg-popover p-6 shadow-2xl duration-200 data-[expanded]:animate-in data-[expanded]:fade-in-0 data-[expanded]:zoom-in-95 data-[closed]:animate-out data-[closed]:fade-out-0 data-[closed]:zoom-out-95 rounded-xl",
          local.class
        )}
        {...rest}
      >
        {local.children}
      </KobalteAlertDialog.Content>
    </AlertDialogPortal>
  )
}

function AlertDialogHeader(props: JSX.HTMLAttributes<HTMLDivElement>) {
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

function AlertDialogFooter(props: JSX.HTMLAttributes<HTMLDivElement>) {
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

function AlertDialogTitle(props: JSX.HTMLAttributes<HTMLHeadingElement>) {
  const [local, rest] = splitProps(props, ["class", "children"])
  return (
    <KobalteAlertDialog.Title
      class={cn("text-lg font-semibold", local.class)}
      {...rest}
    >
      {local.children}
    </KobalteAlertDialog.Title>
  )
}

function AlertDialogDescription(props: JSX.HTMLAttributes<HTMLParagraphElement>) {
  const [local, rest] = splitProps(props, ["class", "children"])
  return (
    <KobalteAlertDialog.Description
      class={cn("text-sm text-muted-foreground", local.class)}
      {...rest}
    >
      {local.children}
    </KobalteAlertDialog.Description>
  )
}

function AlertDialogAction(props: JSX.ButtonHTMLAttributes<HTMLButtonElement>) {
  const [local, rest] = splitProps(props, ["class", "children"])
  return (
    <KobalteAlertDialog.CloseButton
      class={cn(buttonVariants(), local.class)}
      {...rest}
    >
      {local.children}
    </KobalteAlertDialog.CloseButton>
  )
}

function AlertDialogCancel(props: JSX.ButtonHTMLAttributes<HTMLButtonElement>) {
  const [local, rest] = splitProps(props, ["class", "children"])
  return (
    <KobalteAlertDialog.CloseButton
      class={cn(buttonVariants({ variant: "outline" }), "mt-2 sm:mt-0", local.class)}
      {...rest}
    >
      {local.children}
    </KobalteAlertDialog.CloseButton>
  )
}

export {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
}
