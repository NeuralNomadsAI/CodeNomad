// Initial activation is Location-local, including after a daemon restart.
// The fixture's existing until owns its process/error checks and polling budget.
export async function waitNativePruningPlugin({ client, location, locationOptions, signal, until }) {
  let plugins
  try {
    await until(async () => {
      signal.throwIfAborted()
      plugins = (await client.plugin.list({ location }, { ...locationOptions, signal })).data
      signal.throwIfAborted()
      const failed = plugins.filter(item => item.source.type !== "builtin" && item.state.status === "failed")
      if (failed.length) throw new Error(`Plugin activation failed: ${JSON.stringify(failed)}`)
      const plugin = plugins.find(item => item.id === "codenomad-session-pruning")
      if (plugin && plugin.state.status !== "active") throw new Error(`Plugin inactive: ${JSON.stringify(plugin)}`)
      return plugin?.state.status === "active"
    })
  } catch (error) {
    throw new Error(`Native pruning discovery failed: ${JSON.stringify({ location, plugins })}`, { cause: error })
  }
}
