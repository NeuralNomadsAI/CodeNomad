import { parseDocument } from "yaml"

export function parseSettingsYaml(source: string): unknown {
  const document = parseDocument(source, { logLevel: "silent", prettyErrors: false })
  if (document.errors.length) throw new Error("Invalid YAML settings document")
  return document.toJS()
}
