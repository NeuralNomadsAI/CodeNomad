declare module "diff" {
  // Minimal types for the jsdiff package used in git-change reconstruction.
  export function parsePatch(input: string, options?: any): any[]
  export function applyPatch(source: string, patch: any, options?: any): string | false
}
