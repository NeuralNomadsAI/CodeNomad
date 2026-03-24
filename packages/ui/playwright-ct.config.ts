import { defineConfig } from '@sand4rt/experimental-ct-solid';
import solidPlugin from 'vite-plugin-solid';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  timeout: 15 * 1000,
  fullyParallel: true,
  use: {
    trace: 'on-first-retry',
    ctPort: 6789,
    ctViteConfig: {
      plugins: [
        solidPlugin()
      ],
      css: {
        postcss: './postcss.config.js'
      },
      resolve: {
        alias: [
          { find: "@", replacement: resolve(__dirname, "src").replace(/\\/g, "/") },
        ],
        dedupe: ["solid-js", "solid-js/web", "solid-js/store"],
      },
      optimizeDeps: {
        exclude: ["solid-js", "solid-js/web", "solid-js/store", "lucide-solid", "virtua", "solid-toast"],
      },
      ssr: {
        noExternal: ["virtua", "lucide-solid"],
      },
    }
  }
});
