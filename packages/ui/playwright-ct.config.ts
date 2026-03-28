import { defineConfig } from '@sand4rt/experimental-ct-solid';
import solidPlugin from 'vite-plugin-solid';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// 1. Initialize SSR Shims (Node environment)
// This satisfies browser-only libraries during the build pass.
import './src/lib/ssr-shim';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  testDir: './src',
  timeout: 15 * 1000,
  fullyParallel: false,
  workers: 1,
  use: {
    viewport: { width: 1920, height: 1080 },
    trace: 'on-first-retry',
    launchOptions: {
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
    ctPort: 6789,
    ctViteConfig: {
      esbuild: {
        jsx: 'automatic',
        jsxImportSource: 'solid-js',
      },
      plugins: [solidPlugin()],
      css: {
        postcss: './postcss.config.js'
      },
      resolve: {
        alias: {
          "@": resolve(__dirname, "src").replace(/\\/g, "/"),
          // Map all non-browser compatible imports to our single consolidated shim
          "solid-toast": resolve(__dirname, "src/lib/ssr-shim.ts").replace(/\\/g, "/"),
          "react": resolve(__dirname, "src/lib/ssr-shim.ts").replace(/\\/g, "/"),
          "react-dom": resolve(__dirname, "src/lib/ssr-shim.ts").replace(/\\/g, "/"),
        },
        conditions: ["browser", "solid"],
        dedupe: ["solid-js", "solid-js/web", "solid-js/store"],
      },
      optimizeDeps: {
        exclude: ["solid-js", "solid-js/web", "solid-js/store", "lucide-solid", "virtua", "react", "solid-toast"],
      },
      build: {
        rollupOptions: {
          external: [],
        },
      },
      ssr: {
        noExternal: true,
        resolve: {
          conditions: ["browser", "solid"],
        },
      },
    }
  }
});
