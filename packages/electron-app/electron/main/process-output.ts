export function tolerateBrokenPipe(stream: NodeJS.EventEmitter): void {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error
  })
}

tolerateBrokenPipe(process.stdout)
tolerateBrokenPipe(process.stderr)
