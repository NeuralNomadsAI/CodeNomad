import { type JSX, splitProps } from "solid-js"
import { Tabs as KobalteTabs } from "@kobalte/core/tabs"
import { cn } from "../../lib/cn"

const Tabs = KobalteTabs

function TabsList(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ["class", "children"])
  return (
    <KobalteTabs.List
      class={cn(
        "inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground",
        local.class
      )}
      {...rest}
    >
      {local.children}
    </KobalteTabs.List>
  )
}

function TabsTrigger(props: JSX.HTMLAttributes<HTMLButtonElement> & { value: string }) {
  const [local, rest] = splitProps(props, ["class", "children", "value"])
  return (
    <KobalteTabs.Trigger
      value={local.value}
      class={cn(
        "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[selected]:bg-background data-[selected]:text-foreground data-[selected]:shadow",
        local.class
      )}
      {...rest}
    >
      {local.children}
    </KobalteTabs.Trigger>
  )
}

function TabsContent(props: JSX.HTMLAttributes<HTMLDivElement> & { value: string }) {
  const [local, rest] = splitProps(props, ["class", "children", "value"])
  return (
    <KobalteTabs.Content
      value={local.value}
      class={cn(
        "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        local.class
      )}
      {...rest}
    >
      {local.children}
    </KobalteTabs.Content>
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
