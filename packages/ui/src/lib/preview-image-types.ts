const types: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml", ico: "image/x-icon", bmp: "image/bmp", avif: "image/avif" }

/** The MIME type of an image the file preview shows, by extension. */
export const previewImageType = (path: string): string | undefined => types[path.split(".").pop()!.toLowerCase()]
