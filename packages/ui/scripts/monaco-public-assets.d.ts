export type CopyMonacoPublicAssetsParams = {
  uiRendererRoot: string
  warn?: (message: string) => void
  sourceRoots?: string[]
}

export function copyMonacoPublicAssets(params: CopyMonacoPublicAssetsParams): void
