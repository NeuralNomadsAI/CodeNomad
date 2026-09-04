export {}

declare global {
  interface ElectronBrowserWebviewElement extends HTMLElement {
    canGoBack(): boolean
    goBack(): void
    getURL(): string
    getWebContentsId(): number
    loadURL(url: string): Promise<void>
    reload(): void
  }
}

declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      webview: HTMLAttributes<ElectronBrowserWebviewElement> & {
        src?: string
        partition?: string
        allowpopups?: boolean
      }
    }
  }
}
