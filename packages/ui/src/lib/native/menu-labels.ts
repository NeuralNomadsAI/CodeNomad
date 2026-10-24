/** Native application menu labels, translated by the renderer and applied by the
 * Electron/Tauri hosts. Hosts keep their English defaults for missing keys. */
export const NATIVE_MENU_LABEL_KEYS = {
  file: "window.menu.file",
  edit: "window.menu.edit",
  view: "window.menu.view",
  window: "window.menu.window",
  help: "window.menu.help",
  about: "commands.openAbout.label",
  getUpdates: "window.menu.native.getUpdates",
  codenomadHelp: "window.menu.native.codenomadHelp",
  hide: "window.menu.native.hide",
  hideOthers: "window.menu.native.hideOthers",
  showAll: "window.menu.native.showAll",
  quit: "window.menu.native.quit",
  openFolder: "window.menu.native.openFolder",
  openTerminal: "window.menu.native.openTerminal",
  openIn: "window.menu.native.openIn",
  closeWindow: "window.menu.native.closeWindow",
  undo: "window.menu.native.undo",
  redo: "window.menu.native.redo",
  cut: "window.menu.native.cut",
  copy: "window.menu.native.copy",
  paste: "window.menu.native.paste",
  pasteAndMatchStyle: "window.menu.native.pasteAndMatchStyle",
  delete: "window.menu.native.delete",
  selectAll: "window.menu.native.selectAll",
  reload: "window.menu.native.reload",
  forceReload: "window.menu.native.forceReload",
  devTools: "window.menu.native.devTools",
  actualSize: "window.menu.native.actualSize",
  zoomIn: "window.menu.native.zoomIn",
  zoomOut: "window.menu.native.zoomOut",
  fullScreen: "window.menu.native.fullScreen",
  newWindow: "window.menu.native.newWindow",
  newInstance: "commands.newInstance.label",
  commandPalette: "commandPalette.title",
  minimize: "window.menu.native.minimize",
  maximize: "window.menu.native.maximize",
  zoom: "window.menu.native.zoom",
  bringAllToFront: "window.menu.native.bringAllToFront",
} as const

export type NativeMenuLabels = Record<keyof typeof NATIVE_MENU_LABEL_KEYS, string>

export function nativeMenuLabels(t: (key: string) => string): NativeMenuLabels {
  return Object.fromEntries(Object.entries(NATIVE_MENU_LABEL_KEYS).map(([name, key]) => [name, t(key)])) as NativeMenuLabels
}
