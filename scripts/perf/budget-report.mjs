import assert from "node:assert/strict"

export function assertRatchet(base, candidate) {
  function constrain(previous, next, context) {
    assert.deepEqual(Object.keys(next ?? {}).sort(), Object.keys(previous).sort(), `${context} budget keys changed`)
    for (const [name, { max }] of Object.entries(previous)) {
      const proposed = next[name].max
      assert(Number.isFinite(proposed) && proposed <= max, `${context} ${name} budget increased above dev (${proposed} > ${max})`)
    }
  }
  constrain(base.counters, candidate.counters, "Renderer counter")
  assert.deepEqual(Object.keys(candidate.latency).sort(), Object.keys(base.latency).sort(), "Latency levels changed")
  for (const [level, metrics] of Object.entries(base.latency)) constrain(metrics, candidate.latency[level], `L${level} latency`)
}

export function budgetReport(budgets, counter, ratios) {
  assert.deepEqual(Object.keys(budgets.counters).sort(), Object.keys(counter.metrics).sort(), "Counter budget keys differ from observed metrics")
  const failures = [], rows = []
  function check(name, value, { max }, detail = "") {
    assert(Number.isFinite(value) && Number.isFinite(max) && max >= 0, `Missing or invalid measurement or budget: ${name}`)
    const ok = value <= max
    rows.push(`| ${ok ? "OK" : "**FAIL**"} | ${name} | ${ok ? value.toFixed(2) : value} | ${ok ? max.toFixed(2) : max} | ${detail} |`)
    if (!ok) failures.push(`${name}: ${value} exceeds ${max}`)
  }
  for (const [key, value] of Object.entries(counter.metrics)) check(`L8 ${key}`, value, budgets.counters[key])
  for (const [level, metrics] of Object.entries(ratios)) for (const [name, value] of Object.entries(metrics)) {
    const raw = value.tui > 0 ? `; raw ${(value.cn / value.tui).toFixed(2)}×` : ""
    check(`L${level} ${name} CodeNomad/TUI (50 ms floor)`, value.ratio, budgets.latency[level][name], `${value.cn.toFixed(1)} ms / ${value.tui.toFixed(1)} ms${raw}`)
  }
  const lines = ["### Performance guard", "", "| | Metric | Value | Limit | Detail |", "|---|---|---:|---:|---|", ...rows]
  if (failures.length) {
    const growth = Object.entries(counter.files).map(([file, now]) => [file, now - (budgets.callsByFile[file] ?? 0)])
      .filter(([, delta]) => delta >= .01).sort((a, b) => b[1] - a[1]).slice(0, 12)
    lines.push("", "Largest increases in JavaScript calls per native event:", "", "| Source file | +calls/event |", "|---|---:|",
      ...(growth.length ? growth.map(([file, delta]) => `| ${file} | ${delta.toFixed(2)} |`) : ["| No measured source-file increase | — |"]))
  }
  return { report: lines.join("\n") + "\n", failures }
}
