export function installClipboardFallbackDom(execCommand: () => boolean, clipboard?: Partial<Pick<Clipboard, "write" | "writeText">>) {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator")
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document")
  const itemDescriptor = Object.getOwnPropertyDescriptor(globalThis, "ClipboardItem")
  let removed = false
  let focusRestored = false
  const textArea = {
    value: "",
    readOnly: false,
    style: {} as CSSStyleDeclaration,
    focus() {},
    select() {},
    remove() { removed = true },
  }
  const activeElement = { focus() { focusRestored = true } }
  const documentMock = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    activeElement,
    createElement: () => textArea,
    body: { appendChild() {} },
    execCommand,
  })

  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard } })
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentMock })
  Object.defineProperty(globalThis, "ClipboardItem", { configurable: true, value: class {} })

  return {
    textArea,
    removed: () => removed,
    focusRestored: () => focusRestored,
    restore() {
      restoreGlobal("navigator", navigatorDescriptor)
      restoreGlobal("document", documentDescriptor)
      restoreGlobal("ClipboardItem", itemDescriptor)
    },
  }
}

function restoreGlobal(name: "navigator" | "document" | "ClipboardItem", descriptor?: PropertyDescriptor) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor)
  else Reflect.deleteProperty(globalThis, name)
}
