import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createRoot } from "solid-js"
import { isServer } from "solid-js/web"

const NO_SESSION_DRAFT_SESSION_ID = "__no_session_draft__"

describe("app session prompt hydration", () => {
  it("keeps pasted and image attachments when hydrating a mounted no-session prompt", { skip: isServer }, async () => {
    const [
      { usePromptAttachments },
      { usePromptState },
      { clearInstanceAttachments, getAttachments },
      { hydrateWorkspacePromptState },
      {
        clearInstanceDraftPrompts,
        clearSessionDraftPrompt,
        getAuthoritativeDraftSessionIdsForInstance,
        getSessionDraftPrompt,
      },
    ] = await Promise.all([
      import("../components/prompt-input/usePromptAttachments.ts"),
      import("../components/prompt-input/usePromptState.ts"),
      import("./attachments.ts"),
      import("./app-session-prompt-hydration.ts"),
      import("./sessions.ts"),
    ])
    const instanceId = "mounted-no-session-instance"
    let dispose = () => {}
    let prompt = () => ""

    createRoot((rootDispose) => {
      dispose = rootDispose
      const promptState = usePromptState({
        instanceId: () => instanceId,
        sessionId: () => NO_SESSION_DRAFT_SESSION_ID,
        instanceFolder: () => "",
      })
      prompt = promptState.prompt
      usePromptAttachments({
        instanceId: () => instanceId,
        sessionId: () => NO_SESSION_DRAFT_SESSION_ID,
        instanceFolder: () => "/work",
        prompt: promptState.prompt,
        setPrompt: promptState.setPrompt,
        getTextarea: () => null,
      })
    })

    try {
      hydrateWorkspacePromptState(instanceId, {
        drafts: {
          [NO_SESSION_DRAFT_SESSION_ID]: "before [pasted #1] and [Image #1] after",
          "ordinary-session": "ordinary draft",
        },
        attachments: {
          [NO_SESSION_DRAFT_SESSION_ID]: [{
            id: "paste-1",
            type: "text",
            display: "pasted #1 (4 lines)",
            url: "",
            filename: "paste-1.txt",
            mediaType: "text/plain",
            source: { type: "text", value: "restored pasted text" },
          }, {
            id: "image-1",
            type: "file",
            display: "[Image #1]",
            url: "",
            filename: "image-1.png",
            mediaType: "image/png",
            source: { type: "file", path: "/work/image-1.png", mime: "image/png" },
          }],
        },
      }, new Set(["ordinary-session"]), NO_SESSION_DRAFT_SESSION_ID)

      assert.equal(prompt(), "before [pasted #1] and [Image #1] after")
      assert.deepEqual(
        getAttachments(instanceId, NO_SESSION_DRAFT_SESSION_ID).map((attachment) => attachment.id),
        ["paste-1", "image-1"],
      )
      assert.equal(getSessionDraftPrompt(instanceId, "ordinary-session"), "ordinary draft")
      assert.equal(getAuthoritativeDraftSessionIdsForInstance(instanceId).has("ordinary-session"), false)

      clearSessionDraftPrompt(instanceId, "ordinary-session")
      assert.equal(getSessionDraftPrompt(instanceId, "ordinary-session"), "")
      assert.equal(getAuthoritativeDraftSessionIdsForInstance(instanceId).has("ordinary-session"), true)
    } finally {
      dispose()
      clearInstanceAttachments(instanceId)
      clearInstanceDraftPrompts(instanceId)
    }
  })
})
