// tsc emits relative imports without extensions. They name the compiled `.js`
// module, which is tried first: dist also holds extensionless native helpers
// (the macOS supervision helper shares its module's name) that must never be
// loaded as JavaScript. Other relative specifiers keep their own resolution.
export async function resolve(specifier: string, context: any, defaultResolve: any) {
  if (isRelative(specifier) && !specifier.endsWith(".js")) {
    try {
      return await defaultResolve(`${specifier}.js`, context, defaultResolve)
    } catch (error: any) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error
    }
  }
  return defaultResolve(specifier, context, defaultResolve)
}

function isRelative(specifier: string) {
  return specifier.startsWith("./") || specifier.startsWith("../")
}
