import assert from "node:assert/strict"
import { test } from "node:test"
import { ansiToHtml, createAnsiStreamRenderer } from "./ansi"
import { contrastRatio, oklab } from "./color-contrast"
import { HIGH_CONTRAST_TARGETS } from "./high-contrast"

test("ANSI preserves normal styling, escaping and hidden text in forced colors", () => {
  assert.match(ansiToHtml("\x1b[2m<&"), /opacity: 0.7.*&lt;&amp;/)
  assert.doesNotMatch(ansiToHtml("\x1b[2mdim", { forcedColors: true }), /opacity/)
  assert.match(ansiToHtml("\x1b[31;2mdim", { forcedColors: true }), /color: GrayText/)
  assert.doesNotMatch(ansiToHtml("regular", { forcedColors: true }), /GrayText/)
  assert.match(ansiToHtml("\x1b[8msecret", { forcedColors: true }), /visibility: hidden; color: transparent; background-color: transparent/)
  assert.match(ansiToHtml("\x1b[2;8msecret", { forcedColors: true }), /color: GrayText; visibility: hidden; color: transparent; background-color: transparent/)
})

test("high contrast strengthens ANSI text on its actual background and keeps a dim tier and hue", () => {
  for (const background of ["#101010", "#FAFAFA"]) {
    const options = { highContrast: true, foreground: "#777777", background }
    const html = ansiToHtml("\x1b[31mred\x1b[2mdim\x1b[0m", options)
    const colors = [...html.matchAll(/style="color: (#[0-9A-F]{6})/g)].map(match => match[1])
    assert.equal(colors.length, 2)
    assert.ok(contrastRatio(colors[1], background) >= HIGH_CONTRAST_TARGETS.text)
    assert.ok(contrastRatio(colors[0], background) > contrastRatio(colors[1], background))
    assert.ok(oklab(colors[0])[1] > 0, "red retains its hue")
    assert.doesNotMatch(html, /opacity/)
    const explicit = ansiToHtml("\x1b[48;2;0;0;0m\x1b[38;2;100;20;20mcustom", options)
    const foreground = explicit.match(/color: (#[0-9A-F]{6})/)![1]
    assert.ok(contrastRatio(foreground, "#000000") >= HIGH_CONTRAST_TARGETS.text)
    assert.match(ansiToHtml("\x1b[8msecret", options), /visibility: hidden/)
  }
})

test("ANSI streams retain decorations across chunks and reset without changing source", () => {
  const renderer = createAnsiStreamRenderer()
  const options = { highContrast: true, foreground: "#CCCCCC", background: "#101010" }
  renderer.render("\x1b[31;2mfirst", options)
  assert.equal(renderer.render("second", options), ansiToHtml("\x1b[31;2msecond", options))
  renderer.reset()
  assert.equal(renderer.render("plain"), "plain")
})

test("explicit middle-red and gray ANSI backgrounds leave room for readable normal and dim text", () => {
  for (const [sequence, background] of [["255;0;0", "#FF0000"], ["119;119;119", "#777777"]]) {
    const source = `\x1b[48;2;${sequence}m\x1b[38;2;119;119;119mregular\x1b[2mdim\x1b[8msecret`
    const normal = ansiToHtml(source)
    assert.ok(normal.toUpperCase().includes(`BACKGROUND-COLOR: ${background}`))
    const html = ansiToHtml(source, { highContrast: true, foreground: "#CCCCCC", background: "#101010" })
    const styles = [...html.matchAll(/style="color: (#[0-9A-F]{6}); background-color: (#[0-9A-F]{6})/g)]
    assert.equal(styles.length, 3)
    assert.notEqual(styles[0][2], background)
    assert.equal(styles[0][2], styles[1][2], "dim retains the same adjusted background")
    const regular = contrastRatio(styles[0][1], styles[0][2]), dim = contrastRatio(styles[1][1], styles[1][2])
    assert.ok(regular >= 10 && dim >= HIGH_CONTRAST_TARGETS.text && regular > dim, `${background}: ${regular}, ${dim}`)
    if (background === "#FF0000") assert.ok(oklab(styles[0][2])[1] > .01, "adjusted red background retains its hue")
    assert.match(html, /visibility: hidden/)
    assert.equal(ansiToHtml(source), normal, "native source and normal rendering stay intact")
  }
})

test("dim remains weaker than already high-contrast white-on-black and black-on-white", () => {
  for (const [foreground, background, channels] of [
    ["#FFFFFF", "#000000", "255;255;255"], ["#000000", "#FFFFFF", "0;0;0"],
  ]) {
    const html = ansiToHtml(`\x1b[38;2;${channels}mregular\x1b[2mdim\x1b[8msecret`, {
      highContrast: true, foreground, background,
    })
    const colors = [...html.matchAll(/style="color: (#[0-9A-F]{6})/g)].map(match => match[1])
    assert.equal(colors[0], foreground, "normal text retains its native maximum contrast")
    const regular = contrastRatio(colors[0], background), dim = contrastRatio(colors[1], background)
    assert.ok(dim >= HIGH_CONTRAST_TARGETS.text && dim < regular, `${foreground}/${background}: ${regular}, ${dim}`)
    assert.doesNotMatch(html, /opacity/)
    assert.match(html, /visibility: hidden/)
  }
})
