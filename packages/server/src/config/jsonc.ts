export function stripJsonc(input: string): string {
  let output = ""
  let inString = false
  let escape = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    const next = input[index + 1] as string | undefined

    if (escape) {
      output += char
      escape = false
      continue
    }

    if (char === "\\" && inString) {
      output += char
      escape = true
      continue
    }

    if (char === '"') {
      output += char
      inString = !inString
      continue
    }

    if (!inString && char === "/" && next === "/") {
      while (index < input.length && input[index] !== "\n") {
        index += 1
      }
      output += "\n"
      continue
    }

    if (!inString && char === "/" && next === "*") {
      index += 2
      while (index < input.length && !(input[index] === "*" && input[index + 1] === "/")) {
        output += input[index] === "\n" ? "\n" : ""
        index += 1
      }
      index += 1
      continue
    }

    if (!inString && char === ",") {
      let lookahead = index + 1
      while (lookahead < input.length && /\s/.test(input[lookahead]!)) {
        lookahead += 1
      }
      if (input[lookahead] === "}" || input[lookahead] === "]") {
        continue
      }
    }

    output += char
  }

  return output
}
