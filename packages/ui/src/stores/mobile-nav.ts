import { createSignal } from "solid-js"

export type MobileTab = "chat" | "sessions" | "work" | "settings"

const [activeMobileTab, setActiveMobileTab] = createSignal<MobileTab>("chat")

export { activeMobileTab, setActiveMobileTab }
