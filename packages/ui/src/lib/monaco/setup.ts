type RequireFn = (deps: string[], callback: (...args: any[]) => void, errback?: (err: any) => void) => void
type MonacoApi = any

const MONACO_VERSION = "0.52.2"
const CDN_VS_ROOT = `https://cdn.jsdelivr.net/npm/monaco-editor@${MONACO_VERSION}/min/vs`
const LOCAL_VS_ROOT = "/monaco/vs"

let monacoPromise: Promise<MonacoApi> | null = null

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error("timeout")), ms)
    promise
      .then((value) => {
        clearTimeout(id)
        resolve(value)
      })
      .catch((err) => {
        clearTimeout(id)
        reject(err)
      })
  })
}

async function canReachCdn(): Promise<boolean> {
  if (typeof fetch === "undefined") return false
  try {
    const controller = new AbortController()
    const task = fetch(`${CDN_VS_ROOT}/loader.js`, { method: "HEAD", signal: controller.signal })
    const response = await withTimeout(task, 1200)
    controller.abort()
    return response.ok
  } catch {
    return false
  }
}

function ensureLoaderScript(): Promise<void> {
  if (typeof document === "undefined") return Promise.resolve()
  const existing = document.querySelector('script[data-monaco-loader="true"]')
  if (existing) return Promise.resolve()

  return new Promise((resolve, reject) => {
    const script = document.createElement("script")
    script.dataset.monacoLoader = "true"
    script.src = `${LOCAL_VS_ROOT}/loader.js`
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error("Failed to load Monaco AMD loader"))
    document.head.appendChild(script)
  })
}

function ensureEditorCss(): void {
  if (typeof document === "undefined") return
  const existing = document.querySelector('link[data-monaco-editor-css="true"]')
  if (existing) return

  // Some environments don't reliably load `vs/css!` plugin resources.
  // Loading the core stylesheet explicitly keeps Monaco visible.
  const link = document.createElement("link")
  link.rel = "stylesheet"
  link.href = `${LOCAL_VS_ROOT}/editor/editor.main.css`
  ;(link as any).dataset.monacoEditorCss = "true"
  document.head.appendChild(link)
}

function configureWorkers() {
  const globalAny = globalThis as any
  const prevEnv = globalAny.MonacoEnvironment ?? {}

  // Monaco's AMD build no longer ships `editor.worker.js` (and language workers are
  // `jsonWorker.js`, `cssWorker.js`, etc). The robust approach is to always boot
  // `vs/base/worker/workerMain.js` and let it `require(...)` the requested module.
  //
  // Important: `workerMain.js` expects `MonacoEnvironment.baseUrl` to be the
  // directory containing the `vs/` folder (so `/monaco/`, not `/monaco/vs`).
  // Use a static worker bootstrap script rather than a `data:` URL.
  // This avoids CSP issues and makes worker requests visible in DevTools.
  const workerUrl = "/monaco.worker.js"

  globalAny.MonacoEnvironment = {
    ...prevEnv,
    getWorkerUrl(_moduleId: string, _label: string) {
      return workerUrl
    },
  }
}

function getRequire(): RequireFn {
  const req = (globalThis as any).require as RequireFn | undefined
  if (!req) throw new Error("Monaco AMD loader is not available")
  return req
}

function getRequireConfig(): ((config: any) => void) {
  const req = getRequire() as any
  const cfg = req.config as ((config: any) => void) | undefined
  if (!cfg) throw new Error("require.config is not available")
  return cfg
}

function requireAsync(deps: string[]): Promise<any[]> {
  const req = getRequire()
  return new Promise((resolve, reject) => {
    req(deps, (...args: any[]) => resolve(args), (err: any) => reject(err))
  })
}

function getContributionModuleId(languageId: string): string | null {
  const id = String(languageId || "plaintext")
  if (!id || id === "plaintext") return null

  // Rich contributions
  if (id === "typescript" || id === "javascript") return "vs/language/typescript/monaco.contribution"
  if (id === "json") return "vs/language/json/monaco.contribution"
  if (id === "css" || id === "scss" || id === "less") return "vs/language/css/monaco.contribution"
  if (id === "html") return "vs/language/html/monaco.contribution"

  // Basic tokenizers
  // Monaco's `min/vs/basic-languages/<id>/` ships `<id>.js` (no `*.contribution.js`).
  // Loading the tokenizer module is enough; it registers itself with the language service.
  if (id === "toml") return "vs/basic-languages/toml/toml"
  return `vs/basic-languages/${id}/${id}`
}

const loadedContributions = new Set<string>()
const pendingContributions = new Map<string, Promise<void>>()

export async function ensureMonacoLanguageLoaded(languageId: string): Promise<void> {
  const moduleId = getContributionModuleId(languageId)
  if (!moduleId) return

  if (loadedContributions.has(moduleId)) return
  const pending = pendingContributions.get(moduleId)
  if (pending) return pending

  const task = (async () => {
    let loaded = false
    try {
      await requireAsync([moduleId])
      loaded = true
    } catch {
      // ignore
    } finally {
      if (loaded) loadedContributions.add(moduleId)
      pendingContributions.delete(moduleId)
    }
  })()

  pendingContributions.set(moduleId, task)
  return task
}

export async function loadMonaco(): Promise<MonacoApi> {
  if (monacoPromise) return monacoPromise

  monacoPromise = (async () => {
    await ensureLoaderScript()
    configureWorkers()
    ensureEditorCss()

    const online = await canReachCdn()
    const requireConfig = getRequireConfig()

    const paths: Record<string, string> = {
      vs: LOCAL_VS_ROOT,
    }

    if (online) {
      paths["vs/basic-languages"] = `${CDN_VS_ROOT}/basic-languages`
      paths["vs/language"] = `${CDN_VS_ROOT}/language`

      // Baseline languages should remain available offline too.
      paths["vs/basic-languages/python"] = `${LOCAL_VS_ROOT}/basic-languages/python`
      paths["vs/basic-languages/markdown"] = `${LOCAL_VS_ROOT}/basic-languages/markdown`
      paths["vs/basic-languages/cpp"] = `${LOCAL_VS_ROOT}/basic-languages/cpp`
      paths["vs/basic-languages/kotlin"] = `${LOCAL_VS_ROOT}/basic-languages/kotlin`

      paths["vs/language/typescript"] = `${LOCAL_VS_ROOT}/language/typescript`
      paths["vs/language/html"] = `${LOCAL_VS_ROOT}/language/html`
      paths["vs/language/json"] = `${LOCAL_VS_ROOT}/language/json`
      paths["vs/language/css"] = `${LOCAL_VS_ROOT}/language/css`
    }

    requireConfig({
      paths,
      ignoreDuplicateModules: ["vs/editor/editor.main"],
    })

    // Load editor core.
    const [monaco] = await requireAsync(["vs/editor/editor.main"])

    // Load language metadata so we can infer language IDs from paths.
    // (This is small and should remain local for offline support.)
    // Note: In Monaco 0.52.x, `vs/basic-languages/monaco.contribution` is bundled
    // into `vs/editor/editor.main` already. Older builds had additional
    // `vs/basic-languages/_.contribution` metadata, but that module isn't present
    // in the current AMD bundle; attempting to load it can trigger a hard
    // `Unexpected token '<'` if the server falls back to `index.html`.
    await requireAsync(["vs/basic-languages/monaco.contribution"]).catch(() => [])

    return (globalThis as any).monaco ?? monaco
  })()

  return monacoPromise
}
