declare module "tauri-plugin-keepawake-api" {
  export interface KeepAwakeConfig {
    display?: boolean
    idle?: boolean
    sleep?: boolean
  }

  export function start(config?: KeepAwakeConfig): Promise<void>
  export function stop(): Promise<void>
}
