/**
 * Sandbox flags of every browser preview iframe. The path proxy also sends them
 * as `Content-Security-Policy: sandbox`, so a preview document stays an opaque
 * origin however it is opened, including outside its iframe.
 */
export const PREVIEW_SANDBOX_FLAGS = "allow-scripts allow-forms allow-modals allow-popups allow-downloads"
