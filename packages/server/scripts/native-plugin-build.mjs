// Native plugins must share the daemon's Effect fibers, Schema parsers and SDK adapter.
// Bundle application dependencies, but resolve these public modules in OpenCode.
export const nativePluginBuild = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["effect", "@opencode/plugin"],
}
