// Read-only product-transcripts.json / reopened-completed.png trial, 2026-10-03.
// Native child shape retained; provider bookkeeping/encrypted reasoning omitted.
export const nativeChildHistory = [
  { id: "msg_1035e75ed001bINR84ptRnPjZc", type: "user", time: { created: 1791057884793 }, text: "Perform bounded native recursive validation for coordinator's check-result task." },
  { id: "msg_1035e76a9001zO3KRwuXaYSd3Q", type: "assistant", agent: "mission_trial",
    model: { id: "gpt-6.1-sol", providerID: "openai", variant: "default" },
    time: { created: 1791057884849, completed: 1791057896506 }, content: [
      { type: "tool", id: "call_PzYQUeDvMmpiJOuiEW2bgZ2G", name: "subagent", time: { created: 1791057888128, completed: 1791057896476 },
        state: { status: "completed", input: { agent: "mission_trial", description: "Independent arithmetic validation" },
          content: [{ type: "text", text: '<subagent sessionID="grandchild" state="completed">\n17 × 19 = 323  \n23 × 7 = 161  \n323 + 161 = **484**\n</subagent>' }],
          metadata: { sessionID: "grandchild", status: "completed", truncated: false } } },
    ] },
  { id: "msg_1035ea47a001qRQ8kPJ0afLwJv", type: "assistant", agent: "mission_trial",
    model: { id: "gpt-6.1-sol", providerID: "openai", variant: "default" },
    time: { created: 1791057896581, completed: 1791057902917 }, content: [
      { type: "text", text: "Validated result: **484**.\n\nGrandchild evidence: 17×19 = 323; 23×7 = 161; sum = 484. Independently checked using 340−17 = 323 and 140+21 = 161." },
    ] },
  { id: "msg_1035ebdd5001FXmkrY9HdDx9T3", type: "idle", time: { created: 1791057903061 }, outcome: "succeeded" },
]
