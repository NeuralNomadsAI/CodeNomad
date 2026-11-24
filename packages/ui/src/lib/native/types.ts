export type NativeDialogMode = "directory" | "file"

export interface NativeDialogFilter {
  name?: string
  extensions: string[]
}

export interface NativeDialogOptions {
  mode: NativeDialogMode
  title?: string
  defaultPath?: string
  filters?: NativeDialogFilter[]
  multiple?: boolean
}
