import { Component, createSignal, onMount, onCleanup, For, Show } from "solid-js"
import { sessions } from "../stores/sessions"
import { instances, activeInstanceId } from "../stores/instances"
import { Copy, Check, Share2, X, Minimize2, Maximize2 } from "lucide-solid"

const DebugSessionOverlay: Component = () => {
  const [visible, setVisible] = createSignal(false)
  const [minimized, setMinimized] = createSignal(false)
  const [position, setPosition] = createSignal({ x: 20, y: 20 })
  const [copiedId, setCopiedId] = createSignal<string | null>(null)
  const [keyboardInput, setKeyboardInput] = createSignal("")

  const copyToClipboard = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 2000)
    } catch (err) {
      console.error("Failed to copy:", err)
    }
  }

  const shareDebugInfo = async () => {
    const debugInfo = {
      activeInstance: activeInstanceId(),
      instances: Array.from(instances().entries()).map(([id, inst]) => ({
        id,
        folder: inst.folder,
        status: inst.status,
        sessions: Array.from(sessions().get(id)?.entries() || []).map(([sid, sess]) => ({
          id: sid,
          title: sess.title,
          directory: (sess as any).directory,
          parentId: sess.parentId,
        })),
      })),
    }
    const text = JSON.stringify(debugInfo, null, 2)
    await copyToClipboard(text, "share")
  }

  onMount(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      // Ctrl+Shift+D to toggle
      if (e.ctrlKey && e.shiftKey && e.key === "D") {
        e.preventDefault()
        setVisible(!visible())
        if (!visible()) {
          setMinimized(false)
        }
      }
    }
    window.addEventListener("keydown", handleKeyPress)
    onCleanup(() => window.removeEventListener("keydown", handleKeyPress))
  })

  return (
    <>
      {visible() && (
        <div
          style={{
            position: "fixed",
            top: `${position().y}px`,
            left: `${position().x}px`,
            "background-color": "rgba(0, 0, 0, 0.95)",
            color: "#00ff00",
            padding: minimized() ? "8px" : "16px",
            "border-radius": "8px",
            "font-family": "monospace",
            "font-size": "12px",
            "z-index": 99999,
            "max-width": minimized() ? "300px" : "700px",
            "max-height": minimized() ? "auto" : "85vh",
            "overflow-y": minimized() ? "hidden" : "auto",
            border: "2px solid #00ff00",
            "box-shadow": "0 4px 20px rgba(0, 255, 0, 0.3)",
          }}
        >
          <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center", "margin-bottom": minimized() ? "0" : "12px" }}>
            <div style={{ "font-weight": "bold", color: "#ffff00", display: "flex", "align-items": "center", gap: "8px" }}>
              🔧 DEBUG SESSION OVERLAY
            </div>
            <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
              <button
                onClick={() => shareDebugInfo()}
                style={{
                  background: copiedId() === "share" ? "#00ff00" : "rgba(0, 255, 0, 0.2)",
                  border: "1px solid #00ff00",
                  color: copiedId() === "share" ? "#000" : "#00ff00",
                  padding: "4px 8px",
                  "border-radius": "4px",
                  cursor: "pointer",
                  display: "flex",
                  "align-items": "center",
                  gap: "4px",
                  "font-size": "11px",
                }}
                title="Copiar todo como JSON"
              >
                <Show when={copiedId() === "share"} fallback={<Share2 size={14} />}>
                  <Check size={14} />
                </Show>
                Share
              </button>
              <button
                onClick={() => setMinimized(!minimized())}
                style={{
                  background: "rgba(255, 255, 0, 0.2)",
                  border: "1px solid #ffff00",
                  color: "#ffff00",
                  padding: "4px",
                  "border-radius": "4px",
                  cursor: "pointer",
                  display: "flex",
                  "align-items": "center",
                }}
                title={minimized() ? "Maximizar" : "Minimizar"}
              >
                <Show when={minimized()} fallback={<Minimize2 size={14} />}>
                  <Maximize2 size={14} />
                </Show>
              </button>
              <button
                onClick={() => setVisible(false)}
                style={{
                  background: "rgba(255, 0, 0, 0.2)",
                  border: "1px solid #ff0000",
                  color: "#ff0000",
                  padding: "4px",
                  "border-radius": "4px",
                  cursor: "pointer",
                  display: "flex",
                  "align-items": "center",
                }}
                title="Cerrar (Ctrl+Shift+D)"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          <Show when={!minimized()}>
            <div style={{ "margin-bottom": "12px", "padding": "8px", "background-color": "rgba(255, 255, 0, 0.1)", "border-radius": "4px" }}>
              <input
                type="text"
                placeholder="Presiona Ctrl+Shift+D para mostrar/ocultar"
                value={keyboardInput()}
                onInput={(e) => setKeyboardInput(e.currentTarget.value)}
                style={{
                  width: "100%",
                  background: "rgba(0, 0, 0, 0.5)",
                  border: "1px solid #00ff00",
                  color: "#00ff00",
                  padding: "6px",
                  "border-radius": "4px",
                  "font-family": "monospace",
                  "font-size": "12px",
                }}
              />
            </div>

            <div style={{ "margin-bottom": "8px" }}>
              <strong>Active Instance:</strong> {activeInstanceId() || "none"}
            </div>

            <div style={{ "margin-bottom": "12px" }}>
              <strong>Total Instances:</strong> {instances().size}
            </div>

            <For each={Array.from(instances().entries())}>
              {([instanceId, instance]) => (
                <div style={{ "margin-bottom": "16px", "padding": "8px", "background-color": "rgba(255, 255, 255, 0.1)", "border-radius": "4px" }}>
                  <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center" }}>
                    <div style={{ color: "#00ffff", "font-weight": "bold" }}>
                      Instance: {instanceId.substring(0, 12)}...
                    </div>
                    <button
                      onClick={() => copyToClipboard(instanceId, `inst-${instanceId}`)}
                      style={{
                        background: copiedId() === `inst-${instanceId}` ? "#00ff00" : "transparent",
                        border: "1px solid #00ffff",
                        color: copiedId() === `inst-${instanceId}` ? "#000" : "#00ffff",
                        padding: "2px 6px",
                        "border-radius": "3px",
                        cursor: "pointer",
                        "font-size": "10px",
                        display: "flex",
                        "align-items": "center",
                        gap: "4px",
                      }}
                    >
                      <Show when={copiedId() === `inst-${instanceId}`} fallback={<Copy size={12} />}>
                        <Check size={12} />
                      </Show>
                    </button>
                  </div>
                  <div style={{ "margin-left": "8px", "margin-top": "4px" }}>
                    <div>Folder: {instance.folder}</div>
                    <div>Status: {instance.status}</div>
                    <div>
                      Sessions: {sessions().get(instanceId)?.size || 0}
                    </div>
                    <For each={Array.from(sessions().get(instanceId)?.entries() || [])}>
                      {([sessionId, session]) => (
                        <div style={{ "margin-left": "16px", "margin-top": "4px", "padding": "4px", "background-color": "rgba(0, 255, 0, 0.1)", "border-radius": "3px" }}>
                          <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center" }}>
                            <div style={{ color: "#ffff00", "font-size": "11px" }}>
                              {sessionId.substring(0, 20)}...
                            </div>
                            <button
                              onClick={() => copyToClipboard(sessionId, `sess-${sessionId}`)}
                              style={{
                                background: copiedId() === `sess-${sessionId}` ? "#00ff00" : "transparent",
                                border: "1px solid #ffff00",
                                color: copiedId() === `sess-${sessionId}` ? "#000" : "#ffff00",
                                padding: "2px 4px",
                                "border-radius": "2px",
                                cursor: "pointer",
                                "font-size": "9px",
                                display: "flex",
                                "align-items": "center",
                              }}
                            >
                              <Show when={copiedId() === `sess-${sessionId}`} fallback={<Copy size={10} />}>
                                <Check size={10} />
                              </Show>
                            </button>
                          </div>
                          <div style={{ "margin-left": "8px", "font-size": "11px" }}>
                            <div>Title: {session.title}</div>
                            <div>Directory: {(session as any).directory || "N/A"}</div>
                            <div>Parent: {session.parentId || "null"}</div>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </div>
      )}
    </>
  )
}

export default DebugSessionOverlay
