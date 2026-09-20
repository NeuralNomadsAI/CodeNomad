export const navigationMessageId = (index: number) => `msg_${String(index).padStart(5, "0")}`
export const navigationMessage = (index: number) => ({ id: navigationMessageId(index), type: "user" as const,
  time: { created: index + 1 }, text: `Passage ${index}\n\n${"Navigation history content. ".repeat(5 + index % 7)}` })
