export function responseFor(turn, prompt) {
  return `fn main() {\n    println!(${JSON.stringify(`Rune · tour ${turn}: ${prompt}`)});\n}`
}
