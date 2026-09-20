export const navigationMessageId = (index: number) => `msg_${String(index).padStart(5, "0")}`
export const navigationMessage = (index: number) => ({ id: navigationMessageId(index), type: "user" as const,
  time: { created: index + 1 }, text: `Passage ${index}\n\n${"Navigation history content. ".repeat(5 + index % 7)}` })

export const mixedNavigationMessage = (index: number): any => {
  const id = navigationMessageId(index)
  if (index % 5 === 0) return navigationMessage(index)
  if (index % 5 === 4) return { id, type: "idle", outcome: "completed", time: { created: index + 1 } }
  return { id, type: "assistant", agent: "build", model: { providerID: "fixture", id: "fixture" },
    time: { created: index + 1, completed: index + 2 }, content: [
      { type: "reasoning", text: "Considering the next operation. ".repeat(5) },
      ...(index % 5 === 1 ? [{ type: "tool", id: `${id}-tool`, name: "shell", time: { created: index + 1 },
        state: { status: "completed", input: { command: "fixture" }, content: [{ type: "text", text: "Output line\n".repeat(80) }] } }] : []),
      { type: "text", text: `Passage ${index}\n\n` + (index % 5 === 2
        ? "Long paragraph with **formatting** and a [link](https://example.org).\n\n".repeat(40)
        : "Short response.") },
    ] }
}
