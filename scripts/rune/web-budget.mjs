export class BudgetTimeoutError extends Error {}

export const now = () => performance.now()

export async function withBudget(deadline, label, fn) {
  const ms = deadline - now()
  if (ms <= 0) throw new BudgetTimeoutError(`Timeout: ${label}`)
  let timer
  const result = await Promise.race([
    Promise.resolve().then(() => fn(ms)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new BudgetTimeoutError(`Timeout: ${label}`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
  if (now() >= deadline) throw new BudgetTimeoutError(`Timeout: ${label}`)
  return result
}

export function isExpectedWaitError(err) {
  return (
    err instanceof BudgetTimeoutError ||
    err?.name === 'TimeoutError' ||
    (typeof err?.message === 'string' &&
      !/strict mode violation/i.test(err.message) &&
      /Element is not attached to the DOM|Element is detached from the DOM/i.test(err.message))
  )
}
