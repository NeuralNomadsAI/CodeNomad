import assert from "node:assert/strict"
import { beforeEach, describe, it } from "node:test"
import {
  LIVE_VOICE_TOOLS,
  ALLOWED_LIVE_VOICE_TOOL_NAMES,
  toGeminiFunctionDeclarations,
  toOpenAITools,
  executeLiveVoiceTool,
  setActiveFileInfo,
  getActiveFileInfo,
  type LiveVoiceToolCall,
} from "./live-voice-tools"

describe("Live Voice Tools", () => {
  beforeEach(() => {
    setActiveFileInfo(null)
  })

  describe("Schema Declarations", () => {
    it("declares the 4 required live voice tools", () => {
      const toolNames = LIVE_VOICE_TOOLS.map((t) => t.name)
      assert.deepEqual(toolNames, [
        "get_session_status",
        "read_active_file",
        "list_recent_errors",
        "send_prompt_to_agent",
      ])
      assert.equal(ALLOWED_LIVE_VOICE_TOOL_NAMES.size, 4)
      for (const name of toolNames) {
        assert.ok(ALLOWED_LIVE_VOICE_TOOL_NAMES.has(name))
      }
    })

    it("defines valid parameter definitions for each tool", () => {
      const statusTool = LIVE_VOICE_TOOLS.find((t) => t.name === "get_session_status")
      assert.ok(statusTool)
      assert.equal(statusTool.parameters.type, "object")
      assert.ok(statusTool.parameters.properties.instanceId)

      const fileTool = LIVE_VOICE_TOOLS.find((t) => t.name === "read_active_file")
      assert.ok(fileTool)
      assert.equal(fileTool.parameters.type, "object")
      assert.ok(fileTool.parameters.properties.maxLength)

      const errorsTool = LIVE_VOICE_TOOLS.find((t) => t.name === "list_recent_errors")
      assert.ok(errorsTool)
      assert.equal(errorsTool.parameters.type, "object")
      assert.ok(errorsTool.parameters.properties.limit)

      const promptTool = LIVE_VOICE_TOOLS.find((t) => t.name === "send_prompt_to_agent")
      assert.ok(promptTool)
      assert.equal(promptTool.parameters.type, "object")
      assert.ok(promptTool.parameters.properties.prompt)
      assert.deepEqual(promptTool.parameters.required, ["prompt"])
    })
  })

  describe("Provider Format Mappings", () => {
    it("converts tools to Gemini Live function declarations", () => {
      const geminiTools = toGeminiFunctionDeclarations()
      assert.equal(geminiTools.length, 4)

      const sendPrompt = geminiTools.find((t) => t.name === "send_prompt_to_agent")
      assert.ok(sendPrompt)
      assert.equal(sendPrompt.parameters.type, "OBJECT")
      assert.equal(sendPrompt.parameters.properties.prompt.type, "STRING")
      assert.deepEqual(sendPrompt.parameters.required, ["prompt"])

      const readActiveFile = geminiTools.find((t) => t.name === "read_active_file")
      assert.ok(readActiveFile)
      assert.equal(readActiveFile.parameters.type, "OBJECT")
      assert.equal(readActiveFile.parameters.properties.maxLength.type, "NUMBER")
    })

    it("converts tools to OpenAI Realtime tool definitions", () => {
      const openaiTools = toOpenAITools()
      assert.equal(openaiTools.length, 4)

      for (const tool of openaiTools) {
        assert.equal(tool.type, "function")
        assert.equal(tool.parameters.type, "object")
      }

      const sendPrompt = openaiTools.find((t) => t.name === "send_prompt_to_agent")
      assert.ok(sendPrompt)
      assert.equal(sendPrompt.parameters.properties.prompt.type, "string")
      assert.deepEqual(sendPrompt.parameters.required, ["prompt"])
    })
  })

  describe("Security Fence", () => {
    it("rejects unapproved or dangerous tool calls with 'Operation not permitted'", async () => {
      const dangerousCalls: LiveVoiceToolCall[] = [
        { name: "execute_shell_command", arguments: { command: "rm -rf /" } },
        { name: "delete_file", arguments: { path: "/etc/passwd" } },
        { name: "run_terminal", arguments: {} },
        { name: "arbitrary_eval", arguments: {} },
        { name: "", arguments: {} },
      ]

      for (const call of dangerousCalls) {
        const result = await executeLiveVoiceTool(call)
        assert.deepEqual(result, { error: "Operation not permitted" })
      }
    })

    it("rejects null or malformed tool call objects", async () => {
      // @ts-expect-error Testing invalid input
      const result1 = await executeLiveVoiceTool(null)
      assert.deepEqual(result1, { error: "Operation not permitted" })

      // @ts-expect-error Testing invalid input
      const result2 = await executeLiveVoiceTool({ name: 123 })
      assert.deepEqual(result2, { error: "Operation not permitted" })
    })
  })

  describe("Tier 1: Synchronous Read-Only Queries", () => {
    it("executes get_session_status returning agent, model, and active state", async () => {
      const instanceId = "test-instance-1"
      const sessionId = "test-session-1"

      const mockSession = {
        id: sessionId,
        agent: "build",
        model: { providerId: "anthropic", modelId: "claude-3-5-sonnet" },
        status: "working",
        pendingPermission: false,
        pendingForm: false,
      }

      const result = await executeLiveVoiceTool(
        { name: "get_session_status", arguments: { instanceId, sessionId } },
        { instanceId, sessionId, session: mockSession },
      )

      assert.deepEqual(result, {
        instanceId,
        sessionId,
        agent: "build",
        model: "anthropic/claude-3-5-sonnet",
        status: "working",
        pendingPermission: false,
        pendingForm: false,
      })
    })

    it("executes read_active_file returning focused file path and truncated content", async () => {
      setActiveFileInfo({
        path: "src/main.ts",
        content: "const a = 1;\nconsole.log(a);",
      })

      const result = await executeLiveVoiceTool({
        name: "read_active_file",
        arguments: {},
      })

      assert.deepEqual(result, {
        path: "src/main.ts",
        content: "const a = 1;\nconsole.log(a);",
        truncated: false,
      })

      // Test truncation with maxLength
      const longContent = "A".repeat(500)
      setActiveFileInfo({
        path: "src/large.txt",
        content: longContent,
      })

      const truncatedResult = await executeLiveVoiceTool({
        name: "read_active_file",
        arguments: { maxLength: 50 },
      })

      assert.equal((truncatedResult as any).path, "src/large.txt")
      assert.equal((truncatedResult as any).content.length, 50)
      assert.equal((truncatedResult as any).truncated, true)

      // Test when no active file
      setActiveFileInfo(null)
      const noFileResult = await executeLiveVoiceTool({
        name: "read_active_file",
        arguments: {},
      })
      assert.equal((noFileResult as any).path, null)
      assert.equal((noFileResult as any).content, null)
    })

    it("executes list_recent_errors extracting the last 3 errors from transcript", async () => {
      const instanceId = "err-instance"
      const sessionId = "err-session"

      const mockErrors = [
        { id: "msg-4", error: "Disk full", timestamp: 4000 },
        { id: "msg-3", error: "File not found: foo.ts", timestamp: 3000 },
        { id: "msg-2", error: "Rate limit exceeded", timestamp: 2000 },
      ]

      const result = (await executeLiveVoiceTool(
        { name: "list_recent_errors", arguments: { instanceId, sessionId, limit: 3 } },
        { instanceId, sessionId, recentErrors: mockErrors },
      )) as any

      assert.equal(result.instanceId, instanceId)
      assert.equal(result.sessionId, sessionId)
      assert.equal(result.errors.length, 3)
      assert.equal(result.errors[0].error, "Disk full")
      assert.equal(result.errors[1].error, "File not found: foo.ts")
      assert.equal(result.errors[2].error, "Rate limit exceeded")
    })
  })

  describe("Tier 2: Prompt Dispatch", () => {
    it("dispatches prompt via sendMessageFn and immediately returns dispatched status", async () => {
      let dispatchedPrompt = ""
      let dispatchedInstance = ""
      let dispatchedSession = ""
      let sendCalled = false

      const mockSendMessage = async (inst: string, sess: string, text: string) => {
        sendCalled = true
        dispatchedInstance = inst
        dispatchedSession = sess
        dispatchedPrompt = text
        // Simulate background delay
        await new Promise((resolve) => setTimeout(resolve, 50))
        return "msg-dispatched"
      }

      const result = await executeLiveVoiceTool(
        {
          name: "send_prompt_to_agent",
          arguments: {
            instanceId: "inst-1",
            sessionId: "sess-1",
            prompt: "Please fix the failing tests",
          },
        },
        {
          instanceId: "inst-1",
          sessionId: "sess-1",
          sendMessageFn: mockSendMessage,
        },
      )

      assert.deepEqual(result, {
        status: "dispatched",
        message: "Prompt queued for agent execution",
      })

      assert.equal(sendCalled, true)
      assert.equal(dispatchedInstance, "inst-1")
      assert.equal(dispatchedSession, "sess-1")
      assert.equal(dispatchedPrompt, "Please fix the failing tests")
    })

    it("parses stringified JSON arguments properly", async () => {
      let promptSent = ""
      const mockSendMessage = async (_inst: string, _sess: string, text: string) => {
        promptSent = text
        return "msg-id"
      }

      const result = await executeLiveVoiceTool(
        {
          name: "send_prompt_to_agent",
          arguments: JSON.stringify({
            instanceId: "inst-1",
            sessionId: "sess-1",
            prompt: "Refactor component",
          }),
        },
        {
          sendMessageFn: mockSendMessage,
        },
      )

      assert.deepEqual(result, {
        status: "dispatched",
        message: "Prompt queued for agent execution",
      })
      assert.equal(promptSent, "Refactor component")
    })

    it("returns error if prompt is empty", async () => {
      const result = await executeLiveVoiceTool({
        name: "send_prompt_to_agent",
        arguments: { prompt: "   " },
      })
      assert.deepEqual(result, { error: "Prompt text is required" })
    })

    it("returns error if no session is available", async () => {
      const result = await executeLiveVoiceTool({
        name: "send_prompt_to_agent",
        arguments: { prompt: "Hello" },
      })
      assert.deepEqual(result, { error: "No active session available to receive prompt" })
    })
  })
})
