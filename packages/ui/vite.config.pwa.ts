import { copyFileSync } from "fs"
import { defineConfig } from "vite"
import { VitePWA } from "vite-plugin-pwa"
import { resolve } from "path"
import baseConfig from "./vite.config"

export default defineConfig({
  ...baseConfig,
  plugins: [
    ...(baseConfig.plugins ?? []),
    {
      name: "copy-pwa-source-icon",
      buildStart() {
        // vite-pwa-assets requires the source image inside public/
        copyFileSync(
          resolve(__dirname, "src/images/CodeNomad-Icon.png"),
          resolve(__dirname, "src/renderer/public/logo.png"),
        )
      },
    },
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      pwaAssets: {
        preset: "minimal-2023",
        image: "public/logo.png",
      },
      manifest: {
        name: "CodeNomad",
        short_name: "CodeNomad",
        id: "/",
        start_url: "/",
        display: "standalone",
        display_override: ["window-controls-overlay", "standalone"],
        background_color: "#1a1a1a",
        theme_color: "#1a1a1a",
      },
      workbox: {
        navigateFallback: null,
        runtimeCaching: [
          {
            urlPattern: /^\/api\/.*$/i,
            handler: "NetworkFirst",
            options: {
              cacheName: "api-cache",
              expiration: { maxEntries: 50, maxAgeSeconds: 60 },
            },
          },
          {
            urlPattern: /.*\.(?:js|css|png|jpg|jpeg|svg|webp|woff2?)$/i,
            handler: "CacheFirst",
            options: {
              cacheName: "asset-cache",
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
    }),
  ],
})
