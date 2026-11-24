import { fileURLToPath } from "url"
import { dirname, resolve } from "path"

const __dirname = dirname(fileURLToPath(import.meta.url))

export default {
  plugins: {
    tailwindcss: { config: resolve(__dirname, "tailwind.config.js") },
    autoprefixer: {},
  },
}
