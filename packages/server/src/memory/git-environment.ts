// Git's repository-local environment plus discovery/config redirection. Explicit
// unsets cover the WSL execution host as well as variables forwarded by Windows.
const LOCAL = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_IMPLICIT_WORK_TREE", "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_GRAFT_FILE", "GIT_SHALLOW_FILE",
  "GIT_NAMESPACE", "GIT_PREFIX", "GIT_INTERNAL_SUPER_PREFIX", "GIT_REPLACE_REF_BASE", "GIT_NO_REPLACE_OBJECTS",
  "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"]

export const memoryGitEnvironment = (): NodeJS.ProcessEnv => Object.fromEntries(
  [...new Set([...LOCAL, ...Object.keys(process.env).filter(key => /^GIT_/i.test(key))])].map(key => [key, undefined]))
