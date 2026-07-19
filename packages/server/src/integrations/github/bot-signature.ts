const CODENOMAD_BOT_SIGNATURE = "--\nYours, [CodeNomadBot](https://github.com/NeuralNomadsAI/CodeNomad)"

export function appendCodeNomadBotSignature(body: string): string {
  const trimmed = (body ?? "").trimEnd()
  if (!trimmed) return CODENOMAD_BOT_SIGNATURE
  if (trimmed.includes(CODENOMAD_BOT_SIGNATURE)) return trimmed
  return `${trimmed}\n\n${CODENOMAD_BOT_SIGNATURE}`
}
