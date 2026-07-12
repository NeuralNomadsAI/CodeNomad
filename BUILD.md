# Building CodeNomad Binaries

This guide explains how to build distributable binaries for CodeNomad.

## Prerequisites

- **Bun** - Package manager and runtime
- **Node.js** - For electron-builder
- **Electron Builder** - Installed via devDependencies

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
# Portable Electron archive (x64)
npm run build:linux --workspace @neuralnomads/codenomad-electron-app

# Tauri Debian package (x64)
npm exec --workspace @codenomad/tauri-app -- tauri build --bundles deb
```

**Release formats:** Electron `.tar.gz` portable archive and Tauri `.deb` installer.

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

Binaries are generated in the `release/` directory:

```
packages/electron-app/release/
└── CodeNomad-Electron-linux-x64-0.18.0.tar.gz

packages/tauri-app/target/release/bundle/deb/
└── CodeNomad_0.18.0_amd64.deb
```

## File Naming Convention

```
CodeNomad-Electron-{os}-{arch}-{version}.{ext}
CodeNomad-Tauri-{os}-{arch}-{version}.{ext}
```

- **version**: From package.json (e.g., `0.18.0`)
- **os**: `macos`, `windows`, `linux`
- **arch**: `x64`, `arm64`, `universal`
- **ext**: `dmg`, `zip`, `exe`, `deb`, `tar.gz`

The Tauri build directory uses Tauri's native Debian filename. CI renames the package to the convention above when preparing release assets.

## Platform Requirements

### macOS

- **Build on:** macOS 10.13+
- **Run on:** macOS 10.13+
- **Code signing:** Optional (recommended for distribution)

### Windows

- **Build on:** Windows 10+, macOS, or Linux
- **Run on:** Windows 10+
- **Code signing:** Optional (recommended for distribution)

### Linux

- **Build on:** Linux x64
- **Electron portable:** extract the tar.gz and run the `CodeNomad` executable
- **Tauri deb:** built and installation-tested on Ubuntu 24.04; older distributions are not yet guaranteed

## Troubleshooting

### Build fails on macOS

```bash
# Install Xcode Command Line Tools
xcode-select --install
```

### Build fails on Linux

Install the Electron and Tauri build dependencies documented by their upstream projects. Release builds currently target Linux x64 and produce an Electron portable archive plus a Tauri Debian package.

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

- `images/CodeNomad-Icon.png` — primary asset for in-app logo placements and the 1024×1024 master icon used to generate packaged app icons

To update the binaries:

1. Run `node scripts/generate-icons.js images/CodeNomad-Icon.png electron/resources` to round the corners and emit fresh `icon.icns`, `icon.ico`, and `icon.png` files.
2. (Optional) Pass `--radius` to tweak the corner curvature or `--name` to change the filename prefix.
3. If you prefer manual control, export `images/CodeNomad-Icon.png` with your tool of choice and place the generated files in `electron/resources/`.

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
