// Synthetic, public-safe history for the README's multi-project workspace.
export const projectNames = ["Atlas", "API Gateway", "Mobile App", "Design System", "Documentation", "Infrastructure", "Analytics", "Billing"]

export const sessionTitles = [
  "Build the project workspace",
  "Explore the navigation architecture",
  "Review keyboard accessibility",
  "Browser regression tests",
  "Check focus restoration",
  "Audit responsive layouts",
  "Review the implementation",
  "Add full-history search",
  "Optimize timeline rendering",
  "Profile large conversations",
  "Validate scroll anchoring",
  "Improve project switching",
  "Persist window layouts",
  "Restore unsent drafts",
  "Review attachment handling",
  "Add command palette actions",
  "Fix reconnect recovery",
  "Test interrupted requests",
  "Polish the settings panel",
  "Add workspace notifications",
  "Review API pagination",
  "Improve empty states",
  "Update the contributor guide",
  "Refine light and dark palettes",
  "Review provider usage cards",
  "Add file search shortcuts",
  "Test worktree creation",
  "Validate session family moves",
  "Improve Markdown previews",
  "Review background shell output",
  "Add plugin activation controls",
  "Polish the mobile composer",
  "Audit localization coverage",
  "Review the release checklist",
  "Improve startup performance",
  "Add integration test fixtures",
  "Document remote server setup",
  "Review Git diff navigation",
  "Test clipboard attachments",
  "Prepare the next release",
]

export function createReadmeHistory(model: { providerID: string; id: string }, endTime: number): any[] {
  const topics = [
    ["project tabs", "project-tabs"], ["session navigation", "session-tree"],
    ["history search", "history-search"], ["timeline previews", "timeline"],
    ["draft restoration", "drafts"], ["attachment handling", "attachments"],
    ["command palette", "command-palette"], ["responsive panels", "panels"],
    ["worktree selection", "worktrees"], ["provider controls", "providers"],
    ["file previews", "file-preview"], ["keyboard navigation", "project-switcher"],
  ]
  const phases = ["Implement", "Review", "Test", "Refine", "Document"]
  return Array.from({ length: 60 }, (_, index) => {
    const [topic, file] = topics[index % topics.length]
    const phase = phases[Math.floor(index / topics.length)]
    const id = `msg_history_${String(index).padStart(3, "0")}`
    const time = endTime - (60 - index) * 180000
    const tool = index % 3 === 0 ? "read" : index % 3 === 1 ? "patch" : "shell"
    const input = tool === "read" ? { path: `src/components/${file}.tsx` }
      : tool === "patch" ? { patchText: `*** Begin Patch\n*** Update File: src/components/${file}.tsx\n@@\n-// Initial behavior\n+// Preserve selection and keyboard focus\n*** End Patch` }
        : { command: `npm run test:browser -- ${file}` }
    const output = tool === "shell" ? `PASS ${file}.test.ts\n6 tests passed`
      : tool === "read" ? `Read src/components/${file}.tsx, lines 1–180`
        : `Updated src/components/${file}.tsx`
    return [
      { id: `${id}_user`, type: "user", time: { created: time },
        text: `${phase} ${topic} for the multi-project workspace. Preserve the active session and cover the important edge cases.` },
      { id: `${id}_work`, type: "assistant", agent: "build", model, time: { created: time + 1000, completed: time + 45000 }, content: [
        { type: "reasoning", text: `I will trace ${topic} through the existing components and check how selection, focus, and asynchronous updates interact.` },
        { type: "tool", id: `${id}_tool`, name: tool, time: { created: time + 2000 },
          state: { status: "completed", input, content: [{ type: "text", text: output }] } },
      ] },
      { id: `${id}_summary`, type: "assistant", agent: "build", model, time: { created: time + 46000, completed: time + 60000 }, content: [
        { type: "text", text: `### ${phase}: ${topic}\n\nThe workspace now preserves the selected project and session throughout this interaction.\n\n- Checked keyboard and pointer behavior.\n- Covered delayed responses and empty state transitions.\n- Verified the existing layout at desktop and compact widths.\n\nChanges are ready for the next review pass.` },
      ] },
      { id: `${id}_idle`, type: "idle", outcome: "completed", time: { created: time + 61000 } },
    ]
  }).flat()
}
