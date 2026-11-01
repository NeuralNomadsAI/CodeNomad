/** Opening boundary, stricter than the vendored catalogue's display URL schema. */
export function isIntegrationDocsUrl(value: string, integration?: string): boolean {
  const match = /^https:\/\/github\.com\/NeuralNomadsAI\/opencode-integrations\/(tree|blob)\/main\/integrations\/([a-z][a-z0-9-]{0,31})(\/plugin\/README\.md)?$/.exec(value)
  if (!match || (match[1] === "blob") !== Boolean(match[3]) || integration !== undefined && match[2] !== integration) return false
  try {
    const url = new URL(value)
    return url.protocol === "https:" && url.hostname === "github.com" && url.port === ""
      && url.username === "" && url.password === "" && url.search === "" && url.hash === ""
      && url.pathname === `/NeuralNomadsAI/opencode-integrations/${match[1]}/main/integrations/${match[2]}${match[3] ?? ""}`
      && url.href === value
  } catch { return false }
}
