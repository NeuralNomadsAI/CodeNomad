/** Opening boundary, stricter than the vendored catalogue's display URL schema. */
export function isIntegrationDocsUrl(value: string, integration?: string): boolean {
  const prefix = "https://github.com/NeuralNomadsAI/opencode-integrations/tree/main/integrations/"
  const id = value.slice(prefix.length)
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(id) || integration !== undefined && id !== integration) return false
  try {
    const url = new URL(value)
    return url.protocol === "https:" && url.hostname === "github.com" && url.port === ""
      && url.username === "" && url.password === "" && url.search === "" && url.hash === ""
      && url.pathname === `/NeuralNomadsAI/opencode-integrations/tree/main/integrations/${id}`
      && value === `${prefix}${id}` && url.href === value
  } catch { return false }
}
