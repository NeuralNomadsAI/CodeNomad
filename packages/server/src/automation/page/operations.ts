import { applicationOnly, FUNCTION_ARGS, GLOBAL_FUNCTIONS, ELEMENT_FUNCTIONS, type PageFunctionId } from "./functions"
import type { PageOperation } from "./protocol"

const fail = (): never => { throw new Error("Unsupported or invalid browser page operation parameters") }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail()
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, allowed: string[], required: string[] = []) {
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail()
}
const string = (value: unknown, limit = 512): value is string => typeof value === "string" && value.length > 0 && value.length <= limit
const number = (value: unknown, max = 10_000_000): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= max
const integer = (value: unknown, min: number, max: number): value is number => number(value, max) && Number.isSafeInteger(value) && value >= min
function optionalNumber(value: Record<string, unknown>, key: string, max: number, integral = false) {
  if (Object.hasOwn(value, key) && !(integral ? integer(value[key], 0, max) : number(value[key], max))) fail()
}
/** Strict at both ends of the private channel; application provenance never crosses it. */
export function parsePageOperation(raw: unknown, allowApplication = false): PageOperation {
  const value = object(raw)
  try { if (new TextEncoder().encode(JSON.stringify(value)).length > 256 * 1024) fail() } catch { fail() }
  if (!Object.hasOwn(value, "op") || typeof value.op !== "string") fail()
  switch (value.op) {
    case "tree": case "viewport": case "release-handles": case "checkpoint": keys(value, ["op"]); break
    case "resolve": case "geometry": case "scroll-into-view":
      keys(value, ["op", "node"], ["node"])
      if (!integer(value.node, 1, Number.MAX_SAFE_INTEGER)) fail()
      break
    case "hit-test":
      keys(value, ["op", "x", "y"], ["x", "y"])
      if (!number(value.x) || !number(value.y) || !Number.isInteger(value.x) || !Number.isInteger(value.y)) fail()
      break
    case "call": {
      keys(value, ["op", "function", "handle", "args"], ["function", "args"])
      if (typeof value.function !== "string" || !Object.hasOwn(FUNCTION_ARGS, value.function)) fail()
      const id = value.function as PageFunctionId
      if (applicationOnly(id) && !allowApplication) fail()
      if (Object.hasOwn(ELEMENT_FUNCTIONS, id) ? !string(value.handle) : Object.hasOwn(value, "handle")) fail()
      if (!Object.hasOwn(ELEMENT_FUNCTIONS, id) && !Object.hasOwn(GLOBAL_FUNCTIONS, id)) fail()
      const args = value.args
      if (!Array.isArray(args) || args.length !== FUNCTION_ARGS[id].length) return fail()
      for (const [index, rule] of FUNCTION_ARGS[id].entries()) {
        const argument = args[index]
        if (rule === "string" ? typeof argument !== "string"
          : rule === "boolean" ? typeof argument !== "boolean"
          : rule === "strings" ? !Array.isArray(argument) || argument.some(item => typeof item !== "string")
          : rule === "handle" ? !argument || typeof argument !== "object" || Array.isArray(argument) || Object.keys(argument).join() !== "handle" || !string(argument.handle)
          : true) fail()
      }
      break
    }
    case "pointer": case "wheel": case "keyboard": {
      keys(value, ["op", "event"], ["event"])
      const event = object(value.event)
      const common = ["type", "modifiers", "timestamp"]
      optionalNumber(event, "modifiers", 15, true)
      optionalNumber(event, "timestamp", Number.MAX_SAFE_INTEGER)
      if (value.op === "keyboard") {
        keys(event, [...common, "key", "code", "windowsVirtualKeyCode", "text", "unmodifiedText", "location", "buttons"], ["type"])
        if (typeof event.type !== "string" || !["keyDown", "rawKeyDown", "keyUp"].includes(event.type)) fail()
        for (const key of ["key", "code", "text", "unmodifiedText"]) if (Object.hasOwn(event, key) && !string(event[key], 256)) fail()
        optionalNumber(event, "windowsVirtualKeyCode", 65535, true)
        optionalNumber(event, "location", 3, true)
        optionalNumber(event, "buttons", 7, true)
      } else {
        const wheel = value.op === "wheel"
        keys(event, [...common, "x", "y", ...(wheel ? ["deltaX", "deltaY"] : ["button", "buttons", "clickCount"])], ["type", "x", "y", ...(wheel ? ["deltaX", "deltaY"] : [])])
        if (!number(event.x) || !number(event.y)) fail()
        if (wheel) { if (event.type !== "mouseWheel" || !number(event.deltaX) || !number(event.deltaY)) fail() }
        else {
          if (typeof event.type !== "string" || !["mouseMoved", "mousePressed", "mouseReleased"].includes(event.type)) fail()
          if (event.button !== undefined && (typeof event.button !== "string" || !["left", "right", "middle", "none"].includes(event.button))) fail()
          optionalNumber(event, "buttons", 7, true)
          optionalNumber(event, "clickCount", 3, true)
        }
      }
      break
    }
    case "insert-text": keys(value, ["op", "text"], ["text"]); if (typeof value.text !== "string") fail(); break
    default: fail()
  }
  return value as unknown as PageOperation
}

export function pageEnvelope(method: string, input: Record<string, unknown>): void {
  keys(input, ["sessionID", "operationID", ...(method === "browser.page.send" ? ["generation", "operation"] : method === "browser.page.check" || method === "browser.page.end" ? ["generation"] : [])],
    ["sessionID", "operationID", ...(method === "browser.page.send" ? ["generation", "operation"] : method === "browser.page.check" ? ["generation"] : [])])
  if (Object.hasOwn(input, "generation") && !string(input.generation)) fail()
}
