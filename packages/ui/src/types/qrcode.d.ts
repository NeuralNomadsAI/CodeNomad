declare module "qrcode" {
  export function toDataURL(text: string, opts?: Record<string, unknown>): Promise<string>
}
