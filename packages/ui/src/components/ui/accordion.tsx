import { type JSX, splitProps } from "solid-js"
import { Accordion as KobalteAccordion } from "@kobalte/core/accordion"
import { cn } from "../../lib/cn"

const Accordion = KobalteAccordion

function AccordionItem(props: JSX.HTMLAttributes<HTMLDivElement> & { value: string }) {
  const [local, rest] = splitProps(props, ["class", "children", "value"])
  return (
    <KobalteAccordion.Item
      value={local.value}
      class={cn("border-b", local.class)}
      {...rest}
    >
      {local.children}
    </KobalteAccordion.Item>
  )
}

function AccordionTrigger(props: JSX.HTMLAttributes<HTMLButtonElement>) {
  const [local, rest] = splitProps(props, ["class", "children"])
  return (
    <KobalteAccordion.Header class="flex">
      <KobalteAccordion.Trigger
        class={cn(
          "flex flex-1 items-center justify-between py-4 text-sm font-medium transition-all hover:underline [&[data-expanded]>svg]:rotate-180",
          local.class
        )}
        {...rest}
      >
        {local.children}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </KobalteAccordion.Trigger>
    </KobalteAccordion.Header>
  )
}

function AccordionContent(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ["class", "children"])
  return (
    <KobalteAccordion.Content
      class={cn(
        "overflow-hidden text-sm data-[expanded]:animate-accordion-down data-[closed]:animate-accordion-up",
        local.class
      )}
      {...rest}
    >
      <div class="pb-4 pt-0">{local.children}</div>
    </KobalteAccordion.Content>
  )
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent }
