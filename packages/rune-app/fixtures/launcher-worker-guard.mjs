export function needsOwnedWindowsWorker(argv, platform = process.platform) {
  if (platform !== 'win32' || argv.includes('--owned-mobile-worker')) return false
  return argv.includes('--web-android')
    || argv.includes('--web-mobile-more-actions')
    || argv.includes('--web-mobile')
    || argv.includes('--web-keyboard-viewport')
    || argv.includes('--web-mobile-drawers')
}
