export async function resolve(specifier: string, context: any, defaultResolve: any) {
  try {
    return await defaultResolve(specifier, context, defaultResolve)
  } catch (error: any) {
    if (shouldRetry(specifier, error)) {
      const retried = specifier.endsWith(".js") ? specifier : `${specifier}.js`
      return defaultResolve(retried, context, defaultResolve)
    }
    throw error
  }
}

function shouldRetry(specifier: string, error: any) {
  if (!error || error.code !== "ERR_MODULE_NOT_FOUND") {
    return false
  }
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return true
  }
  return false
}
