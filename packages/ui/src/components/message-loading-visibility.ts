export function isInitialMessageLoad(loading: boolean, messageCount: number) {
  return loading && messageCount === 0
}
