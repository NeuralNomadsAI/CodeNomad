# Building CodeNomad Binaries

This guide explains how to build distributable binaries for CodeNomad.

## Prerequisites

- **Bun** - Package manager and runtime
- **Node.js 24 LTS** - Use the exact release pinned in `.node-version` for builds and tests
- **Electron Builder** - Installed via devDependencies

### Bundled server runtime

Both Tauri and Electron ship a separate Node.js executable for the CodeNomad
server. `scripts/prepare-node-runtime.cjs` reads the same `.node-version` pin as
CI, downloads the official target archive, and verifies its SHA-256 before
packaging. Only the executable is bundled, not npm or Corepack. Updating this
pin does not update Electron's internal Node/Chromium, WebView2, the system Node
installation, or the independently managed OpenCode daemon.

For a runtime update, run the server and desktop tests with the pinned Node,
then rebuild and smoke-test the packaged applications on Windows, macOS, and
Linux. Check the upstream Node platform requirements before changing the pin;
Node 24 requires macOS 13.5 or later. Keep both desktop bundle minimum versions
aligned. Keep the version exact rather than resolving `latest` or `lts/*` at
build time so release inputs remain reproducible.

## Quick Start

All commands now run inside the workspace packages. From the repo root you can target the Electron app package directly:

```bash
npm run build --workspace @neuralnomads/codenomad-electron-app
```

### Build for Current Platform (macOS default)

```bash
bun run build:binaries
```

This builds for macOS (Universal - Intel + Apple Silicon) by default.

## Platform-Specific Builds

### macOS

```bash
# Universal (Intel + Apple Silicon) - Recommended
bun run build:mac

# Intel only (x64)
bun run build:mac-x64

# Apple Silicon only (ARM64)
bun run build:mac-arm64
```

**Output formats:** `.dmg`, `.zip`

### Windows

```bash
# x64 (64-bit Intel/AMD)
bun run build:win

# ARM64 (Windows on ARM)
bun run build:win-arm64
```

**Output formats:** `.exe` (NSIS installer), `.zip`

### Linux

```bash
# Electron Debian package (x64)
npm run build:linux --workspace @neuralnomads/codenomad-electron-app

# Tauri AppImage (x64)
npm exec --workspace @codenomad/tauri-app -- tauri build --bundles appimage
```

**Release formats:** Electron `.deb` installer and self-updating Tauri `.AppImage`.

### Build All Platforms

```bash
bun run build:all
```

⚠️ **Note:** Cross-platform builds may have limitations. Build on the target platform for best results.

## Build Process

The build script performs these steps:

1. **Build @neuralnomads/codenomad** → Produces the CLI `dist/` bundle (also rebuilds the UI assets it serves)
2. **Compile TypeScript + bundle with Vite** → Electron main, preload, and renderer output in `dist/`
3. **Package with electron-builder** → Platform-specific binaries

## Output

Build artifacts are generated in package-specific output directories:

```
packages/electron-app/release/
└── CodeNomad-Electron-linux-amd64-0.18.0.deb

packages/tauri-app/target/release/bundle/appimage/
└── CodeNomad_0.18.0_amd64.AppImage
```

## File Naming Convention

```
CodeNomad-Electron-{os}-{arch}-{version}.{ext}
CodeNomad-Tauri-{os}-{arch}-{version}.{ext}
```

- **version**: From package.json (e.g., `0.18.0`)
- **os**: `macos`, `windows`, `linux`
- **arch**: `x64`, `arm64`, `universal`
- **ext**: `zip`, `exe`, `app.tar.gz`, `deb`, `AppImage`

Electron names deb architectures the Debian way (`amd64`) and Tauri keeps its native bundle filenames. CI renames both to the convention above when preparing release assets.

## Platform Requirements

### macOS

- **Build on:** macOS 13.5+ with the required Xcode tools (CI uses macOS 15)
- **Run on:** macOS 13.5+ (Intel and Apple Silicon; required by bundled Node 24)
- **Code signing:** Optional (recommended for distribution)

### Windows

- **Build on:** Windows 10+, macOS, or Linux
- **Run on:** Windows 10+
- **Code signing:** Optional (recommended for distribution)

### Linux

- **Build on:** Linux x64
- **Electron deb:** built and installation-tested on Ubuntu 24.04; its post-install step gives `chrome-sandbox` the root ownership and 4755 mode Chromium's sandbox requires, and it replaces the former Tauri deb (`code-nomad`)
- **Tauri AppImage:** built and tested on Ubuntu 24.04; older distributions are not yet guaranteed

## Troubleshooting

### Build fails on macOS

```bash
# Install Xcode Command Line Tools
xcode-select --install
```

### Build fails on Linux

Install the Electron and Tauri build dependencies documented by their upstream projects. Release builds currently target Linux x64 and produce an Electron Debian package plus a Tauri AppImage.

### "electron-builder not found"

```bash
# Install dependencies
bun install
```

### Build is slow

- Use platform-specific builds instead of `build:all`
- Close other applications to free up resources
- Use SSD for faster I/O

## Development vs Production

**Development:**

```bash
bun run dev           # Hot reload, no packaging
```

**Production:**

```bash
bun run build:binaries # Full build + packaging
```

## CI/CD Integration

Example GitHub Actions workflow:

```yaml
name: Build Binaries

on:
  push:
    tags:
      - "v*"

jobs:
  build-mac:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v3
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun run build:mac

  build-win:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v3
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun run build:win

  build-linux:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun run build:linux
```

## Advanced Configuration

Edit `package.json` → `build` section to customize:

- App icon
- Code signing
- Installer options
- File associations
- Auto-update settings

See [electron-builder docs](https://www.electron.build/) for details.

## Brand Assets

The logo is a hexagon framing a C and an n, drawn in equal bands: ring, gap, letter strokes and counters share one width.

- `images/CodeNomad-Icon.svg` - the app icon's vector source: white ring and letters with black gaps on a transparent square canvas, so one icon reads on light and dark taskbars, docks and tabs
- `packages/ui/src/images/CodeNomad-Logo-OnDark.svg` - the same hexagon cropped to its bounds, for dark palettes and the loading screen
- `packages/ui/src/images/CodeNomad-Logo-OnLight.svg` - its negative (black ring and letters, white gaps) for light palettes

After changing `images/CodeNomad-Icon.svg`, run `node scripts/generate-icons.mjs` from the repository root (it needs Playwright's Chromium: `npx playwright install chromium`). It renders every size straight from the SVG, never shrinking a larger bitmap, and writes `images/CodeNomad-Icon.png` and its copy in `packages/ui/src/images/` (1024 px; the web app icons, the help site logo and the Windows notification icon derive from it), `icon.png`, `icon.ico` (16 to 256 px) and `icon.icns` in `packages/electron-app/electron/resources/` and `packages/tauri-app/src-tauri/`, and the Linux sizes in `packages/tauri-app/src-tauri/icons/linux/`.

## Clean Build

Remove previous builds:

```bash
rm -rf release/ dist/
bun run build:binaries
```

## FAQ

**Q: Can I build for Windows on macOS?**  
A: Yes, but native binaries (e.g., DMG) require the target OS.

**Q: How large are the binaries?**  
A: Approximately 100-150 MB (includes Electron runtime).

**Q: Do I need code signing?**  
A: Not required, but recommended for public distribution to avoid security warnings.

**Q: How do I update the version?**  
A: Update `version` in `package.json`, then rebuild.

## Support

For issues or questions:

- Check [electron-builder documentation](https://www.electron.build/)
- Open an issue in the repository
- Review existing build logs in `release/`
