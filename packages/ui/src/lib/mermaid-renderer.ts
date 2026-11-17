const MAX_SOURCE = 50_000
const MAX_SVG = 2_000_000
const TIMEOUT = 10_000
type Renderer = { frame: HTMLIFrameElement; port: MessagePort }
let runtime: Promise<Renderer> | undefined
let queue: Promise<unknown> = Promise.resolve()
let pending = 0
export interface MermaidAppearance {
  background: string
  surface: string
  secondary: string
  text: string
  border: string
  error: string
}

// One opaque, network-disabled renderer per webview. Only SVG image bytes leave it.
function startRenderer(): Promise<Renderer> {
  return new Promise((resolve, reject) => {
    let finished = false
    let cleanup: (() => void) | undefined
    const fail = () => {
      if (finished) return
      finished = true; clearTimeout(timer); cleanup?.()
      reject(new Error("Mermaid unavailable"))
    }
    const timer = setTimeout(fail, TIMEOUT)
    void Promise.all([import("@mermaid-js/tiny/dist/mermaid.tiny.js?raw"), import("@mermaid-js/tiny/LICENSE?raw")]).then(([{ default: tiny }, { default: license }]) => {
    if (finished) return
    const frame = document.createElement("iframe")
    frame.setAttribute("sandbox", "allow-scripts")
    frame.setAttribute("aria-hidden", "true")
    frame.tabIndex = -1
    frame.className = "mermaid-renderer-frame"
    const channel = new MessageChannel()
    cleanup = () => { frame.remove(); channel.port1.close(); channel.port2.close() }
    channel.port1.onmessage = event => {
      if (finished || event.data !== "ready") return
      finished = true
      clearTimeout(timer)
      channel.port1.onmessage = null
      resolve({ frame, port: channel.port1 })
    }
    let connected = false
    frame.onload = () => {
      if (connected || finished) return
      connected = true
      try { frame.contentWindow?.postMessage("codenomad-mermaid", "*", [channel.port2]) } catch { fail() }
    }
    frame.srcdoc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:; font-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'"><body><script>/*${license}*/\n${tiny.replace(/<\/script/gi, "<\\/script")}<\/script><script>
      addEventListener('message', event => {
        if (event.source !== parent || event.data !== 'codenomad-mermaid' || !event.ports[0]) return;
        const port = event.ports[0];
        port.onmessage = async event => {
          const { code, dark, appearance: a } = event.data;
          try {
            mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false,
              secure: ['secure','securityLevel','startOnLoad','maxTextSize','maxEdges','htmlLabels','theme','themeVariables'],
              maxTextSize: ${MAX_SOURCE}, maxEdges: 500, theme: a ? 'base' : dark ? 'dark' : 'default',
              ...(a ? { themeVariables: {
                darkMode: dark, background: a.background, primaryColor: a.surface, primaryTextColor: a.text,
                primaryBorderColor: a.border, secondaryColor: a.secondary, secondaryTextColor: a.text,
                secondaryBorderColor: a.border, tertiaryColor: a.surface, tertiaryTextColor: a.text,
                tertiaryBorderColor: a.border, textColor: a.text, titleColor: a.text, lineColor: a.border,
                mainBkg: a.surface, nodeTextColor: a.text, edgeLabelBackground: a.background,
                clusterBkg: a.secondary, clusterBorder: a.border, actorBkg: a.surface, actorTextColor: a.text,
                actorBorder: a.border, actorLineColor: a.border, signalColor: a.text, signalTextColor: a.text,
                labelBoxBkgColor: a.surface, labelBoxBorderColor: a.border, labelTextColor: a.text,
                loopTextColor: a.text, noteBkgColor: a.secondary, noteTextColor: a.text, noteBorderColor: a.border,
                activationBkgColor: a.secondary, activationBorderColor: a.border, sequenceNumberColor: a.background,
                taskBkgColor: a.surface, taskTextColor: a.text, taskBorderColor: a.border,
                taskTextDarkColor: a.text, taskTextLightColor: a.text, taskTextOutsideColor: a.text,
                taskTextClickableColor: a.border,
                activeTaskBkgColor: a.secondary, activeTaskBorderColor: a.border,
                doneTaskBkgColor: a.secondary, doneTaskBorderColor: a.border,
                critBkgColor: a.surface, critBorderColor: a.error, todayLineColor: a.error,
                vertLineColor: a.border, gridColor: a.border, excludeBkgColor: a.secondary,
                sectionBkgColor: a.surface, sectionBkgColor2: a.secondary, altSectionBkgColor: a.background,
                sectionTitleColor: a.text
              } } : {}),
              fontFamily: 'Arial, sans-serif', flowchart: { htmlLabels: false } });
            const { svg } = await mermaid.render('diagram', code);
            port.postMessage(svg);
          } catch { port.postMessage(null); }
        };
        port.postMessage('ready');
      }, { once: true });
    <\/script>`
    document.body.append(frame)
    }).catch(fail)
  })
}

/** A bounded render; cancellation drops obsolete work without changing source text. */
export function renderMermaid(code: string, dark: boolean, signal: AbortSignal, appearance?: MermaidAppearance): Promise<string> {
  if (!code.trim() || code.length > MAX_SOURCE || pending >= 16) return Promise.reject(new Error("Mermaid limit"))
  pending++
  // ponytail: serialize Tiny's mutable renderer; separate renderer instances if throughput requires it.
  const task = queue.catch(() => {}).then(async () => {
    signal.throwIfAborted()
    const loading = runtime ??= startRenderer()
    let renderer: Renderer
    try { renderer = await loading } catch (error) { if (runtime === loading) runtime = undefined; throw error }
    signal.throwIfAborted()
    const svg = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        renderer.frame.remove(); renderer.port.close()
        if (runtime === loading) runtime = undefined
        reject(new Error("Mermaid timeout"))
      }, TIMEOUT)
      renderer.port.onmessage = event => {
        clearTimeout(timer)
        renderer.port.onmessage = null
        const value = event.data
        if (typeof value === "string" && value.length <= MAX_SVG && value.includes("<svg")) resolve(value)
        else reject(new Error("Mermaid diagram unavailable"))
      }
      renderer.port.postMessage({ code, dark, appearance })
    })
    signal.throwIfAborted()
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  }).finally(() => { pending-- })
  queue = task
  return task
}
