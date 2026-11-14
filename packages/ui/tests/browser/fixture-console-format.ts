// Test-only Chromium preview/error formatting, adapted from Playwright 1.63.0
// packages/playwright-core/src/server/{chromium/crProtocolHelper,javascript}.ts.
// Copyright (c) Microsoft Corporation. SPDX-License-Identifier: Apache-2.0
// The native console witness in fixture-console.test.ts qualifies this contract.
type RemoteObject = any

function sparseArrayToString(entries: Array<{ name: string; value?: string }>) {
  const arrayEntries = entries.map(({ name, value }) => ({ index: +name, value }))
    .filter(({ index }) => !isNaN(index) && index >= 0).sort((a, b) => a.index - b.index)
  let lastIndex = -1
  const tokens: string[] = []
  for (const { index, value } of arrayEntries) {
    const emptyItems = index - lastIndex - 1
    if (emptyItems === 1) tokens.push("empty")
    else if (emptyItems > 1) tokens.push(`empty x ${emptyItems}`)
    tokens.push(String(value))
    lastIndex = index
  }
  return "[" + tokens.join(", ") + "]"
}

function renderPreview(object: RemoteObject): string | undefined {
  if (object.type === "undefined") return "undefined"
  if ("value" in object) return String(object.value)
  if (object.unserializableValue) return String(object.unserializableValue)
  if (object.description === "Object" && object.preview)
    return "{" + object.preview.properties.map(({ name, value }: any) => `${name}: ${value}`).join(", ") + "}"
  if (object.subtype === "array" && object.preview) return sparseArrayToString(object.preview.properties)
  return object.description
}

export function nativePreview(object: RemoteObject) {
  if (object.subtype === "node") return "JSHandle@node"
  if (object.objectId) return renderPreview(object) || ("JSHandle@" + (object.subtype || object.type))
  const special: Record<string, number> = { NaN, Infinity, "-Infinity": -Infinity, "-0": -0 }
  return String(object.unserializableValue ? special[object.unserializableValue] : object.value)
}

export function exceptionToError(details: any) {
  let text = details.exception ? details.exception.description || String(details.exception.value) : details.text
  if (!details.exception && details.stackTrace) for (const frame of details.stackTrace.callFrames)
    text += `\n    at ${frame.functionName || "<anonymous>"} (${frame.url}:${frame.lineNumber}:${frame.columnNumber})`
  const lines = text.split("\n"), firstFrame = lines.findIndex((line: string) => line.startsWith("    at"))
  const messageWithName = firstFrame === -1 ? text : lines.slice(0, firstFrame).join("\n")
  const separator = messageWithName.indexOf(":")
  const name = separator === -1 ? "" : messageWithName.slice(0, separator)
  const message = separator !== -1 && separator + 2 <= messageWithName.length ? messageWithName.substring(separator + 2) : messageWithName
  const error = new Error(message)
  error.stack = firstFrame === -1 ? "" : text
  const override = details.exception?.preview?.properties.find((value: any) => value.name === "name")
  error.name = override ? override.value ?? "Error" : name
  return error
}
