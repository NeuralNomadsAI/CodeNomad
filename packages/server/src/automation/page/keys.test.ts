import assert from "node:assert/strict"
import { test } from "node:test"
import { keyChord } from "./keys"

const brief = (chord: string, platform: NodeJS.Platform = "win32") =>
  keyChord(chord, platform).map(event => `${event.type}:${event.key}:${event.modifiers}${event.text ? `:${JSON.stringify(event.text)}` : ""}`)

test("plain keys type their text; named keys dispatch without text except Enter and Space", () => {
  assert.deepEqual(brief("a"), ["keyDown:a:0:\"a\"", "keyUp:a:0"])
  assert.deepEqual(brief("Enter"), ["keyDown:Enter:0:\"\\r\"", "keyUp:Enter:0"])
  assert.deepEqual(brief("Space"), ["keyDown: :0:\" \"", "keyUp: :0"])
  assert.deepEqual(brief("Escape"), ["rawKeyDown:Escape:0", "keyUp:Escape:0"])
  assert.deepEqual(brief("esc"), brief("Escape"), "aliases and case-insensitive names")
  assert.deepEqual(brief("arrowdown"), ["rawKeyDown:ArrowDown:0", "keyUp:ArrowDown:0"])
  assert.equal(keyChord("F5")[0].windowsVirtualKeyCode, 116)
  assert.deepEqual(keyChord("/").map(event => event.code), ["Slash", "Slash"])
})

test("chords hold modifiers around the key, type nothing, and release in reverse", () => {
  assert.deepEqual(brief("Control+Shift+K"), [
    "rawKeyDown:Control:2", "rawKeyDown:Shift:10", "rawKeyDown:K:10", "keyUp:K:10", "keyUp:Shift:2", "keyUp:Control:0"])
  assert.deepEqual(brief("Shift+Tab"), ["rawKeyDown:Shift:8", "rawKeyDown:Tab:8", "keyUp:Tab:8", "keyUp:Shift:0"])
  assert.deepEqual(brief("Shift+a"), ["rawKeyDown:Shift:8", "keyDown:A:8:\"A\"", "keyUp:A:8", "keyUp:Shift:0"], "shift types the capital")
  assert.deepEqual(brief("Mod+k", "darwin").slice(0, 2), ["rawKeyDown:Meta:4", "rawKeyDown:k:4"])
  assert.deepEqual(brief("Mod+k", "linux").slice(0, 2), ["rawKeyDown:Control:2", "rawKeyDown:k:2"])
  assert.deepEqual(brief("ctrl+cmd+alt+x").slice(0, 3), ["rawKeyDown:Control:2", "rawKeyDown:Meta:6", "rawKeyDown:Alt:7"])
  assert.deepEqual(brief("+"), ["keyDown:+:0:\"+\"", "keyUp:+:0"])
})

test("unknown keys and modifiers are refused with the accepted vocabulary", () => {
  assert.throws(() => keyChord("Hyper+Q"), /Unknown modifier "Hyper".*Control, Shift, Alt, Meta or Mod/)
  assert.throws(() => keyChord("Enterr"), /Unknown key "Enterr"; use a character or a key name/)
  assert.throws(() => keyChord("Control+"), /Unknown key/)
  assert.throws(() => keyChord("é"), /Unknown key "é"/)
})
