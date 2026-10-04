type Choice = { label: string; description?: string }

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

export function getQuestionReceipts(payload: { input: Record<string, unknown>; metadata: Record<string, unknown>; output: unknown }) {
  const questions = payload.input.questions
  // Native metadata is authoritative, including malformed or explicitly empty answers.
  const answers = Object.prototype.hasOwnProperty.call(payload.metadata, "answers")
    ? payload.metadata.answers : record(payload.output).answers
  if (!Array.isArray(questions)) return []

  return questions.flatMap((value, index) => {
    const question = record(value)
    const prompt = text(question.question) ?? text(question.header)
    if (!prompt) return []
    const options: Choice[] = Array.isArray(question.options) ? question.options.flatMap(value => {
      const option = record(value), label = text(option.label)
      return label ? [{ label, description: text(option.description) }] : []
    }) : []
    const row = Array.isArray(answers) ? answers[index] : undefined
    const labels: string[] | undefined = Array.isArray(row) && row.every(value => typeof value === "string") ? row : undefined
    const selected = labels?.filter(label => label.trim()).map(label => {
      const matches = options.filter(option => option.label === label)
      return { label, description: matches.length === 1 ? matches[0].description : undefined }
    })
    return [{
      prompt,
      header: text(question.header) !== prompt ? text(question.header) : undefined,
      selected,
      remaining: options.filter(option => !labels?.includes(option.label)),
    }]
  })
}
