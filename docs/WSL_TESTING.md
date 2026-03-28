# Running Tests in WSL

This guide explains how to set up your Windows Subsystem for Linux (WSL) environment to run CodeNomad's test suite.

## Prerequisites

1.  **Node.js**: Install Node.js 18+ inside your WSL distribution. **Do not use the Windows version of Node/npm from within WSL.**
    ```bash
    # Example using nvm (highly recommended)
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    nvm install 20
    ```
2.  **Dependencies**: Install project dependencies from the root directory within your WSL shell. This ensures Linux-compatible binaries and symlinks are created.
    ```bash
    npm install
    ```

## Playwright Setup (UI Tests)

Playwright requires specific Linux libraries and browser binaries.

1.  **Install Playwright Browsers**:
    ```bash
    npx playwright install
    ```
2.  **Install System Dependencies**:
    ```bash
    sudo npx playwright install-deps
    ```

## Running Tests

From the repository root, you can run all tests or package-specific tests.

### All Tests
```bash
npm test
```

### UI Component Tests Only
```bash
npm run test:ui
```

### Server Tests Only
```bash
npm run test:server
```

## Troubleshooting

### Headless vs. Headful
By default, tests run in **headless** mode, which is recommended for WSL. If you need to run in headful mode, you must have an X11 or Wayland server configured on Windows (e.g., GWSL or WSLg).

### Performance on /mnt/c/
Running tests on a Windows drive (`/mnt/c/...`) from WSL can be significantly slower than running on the native Linux filesystem (`~/...`). For the best experience, clone the repository directly into your WSL home directory.
