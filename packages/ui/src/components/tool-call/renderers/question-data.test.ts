import assert from "node:assert/strict"
import { test } from "node:test"
import { getQuestionReceipts } from "./question-data"

const options = [
  { label: "Gradual", description: "Release to a small group first." },
  { label: "Everyone", description: "Release to all workspaces." },
  { label: "Preview", description: "Keep collecting feedback." },
]
const question = { header: "Deployment", question: "How should we release?", options }
const read = (answers: unknown, output: unknown = undefined, questions: unknown = [question]) =>
  getQuestionReceipts({ input: { questions }, metadata: { answers }, output })

test("native selected labels retain their descriptions and exclude selected options from details", () => {
  const [receipt] = read([["Everyone"]], { answers: [["Preview"]] })
  assert.equal(receipt.prompt, question.question)
  assert.equal(receipt.header, question.header)
  assert.deepEqual(receipt.selected, [options[1]])
  assert.deepEqual(receipt.remaining, [options[0], options[2]])
})

test("multi-select retains answer order; custom text is literal without a guessed description", () => {
  const custom = "Wait for review.\nThen release <carefully>."
  const [receipt] = read([["Everyone", "Gradual", custom]])
  assert.deepEqual(receipt.selected, [options[1], options[0], { label: custom, description: undefined }])
  assert.deepEqual(receipt.remaining, [options[2]])
  assert.deepEqual(read([["Gradual", "Everyone", "Preview"]])[0].remaining, [])
})

test("absent metadata permits structured output; malformed native answers never fall back", () => {
  assert.deepEqual(getQuestionReceipts({ input: { questions: [question] }, metadata: {}, output: { answers: [["Gradual"]] } })[0].selected, [options[0]])
  for (const answers of [undefined, null, "Gradual", ["Gradual"], [["Gradual", null]], [[{ type: "image", data: "secret-bytes" }]]]) {
    const [receipt] = read(answers, { answers: [["Everyone"]] })
    assert.equal(receipt.selected, undefined)
    assert.deepEqual(receipt.remaining, options)
  }
  assert.deepEqual(read([[]])[0].selected, [])
})

test("malformed questions preserve answer indices; unknown labels and duplicate options stay conservative", () => {
  const receipts = read([["Wrong index"], ["Unknown"]], undefined, [null, question, { question: 4 }])
  assert.equal(receipts.length, 1)
  assert.deepEqual(receipts[0].selected, [{ label: "Unknown", description: undefined }])
  const [duplicate] = read([["Gradual"]], undefined, [{ ...question, options: [options[0], { label: "Gradual", description: "Conflicting description" }, null] }])
  assert.deepEqual(duplicate.selected, [{ label: "Gradual", description: undefined }])
  assert.deepEqual(duplicate.remaining, [])
  assert.deepEqual(read([], undefined, { question: "Invalid container" }), [])
})
