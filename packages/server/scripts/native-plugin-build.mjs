// Native plugins must share the daemon's Effect fibers, Schema parsers and SDK adapter.
// Bundle application dependencies, but resolve these public modules in OpenCode.
export const nativePluginBuild = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["effect", "@opencode/plugin"],
  // The UMD entry hides its relative requires from esbuild; use the ESM entry.
  alias: { "jsonc-parser": "jsonc-parser/lib/esm/main.js" },
  // Native agent/skill files are embedded as text (esbuild already loads `.txt` as text).
  loader: { ".md": "text" },
}
