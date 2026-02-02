import { FastifyInstance } from "fastify"
import fs from "fs"
import path from "path"
import os from "os"
import { execSync } from "child_process"
import type { ProjectInitRequest, ProjectInitResponse } from "../../api-types"

interface RouteDeps {
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void
    error: (msg: string, meta?: Record<string, unknown>) => void
    debug: (msg: string, meta?: Record<string, unknown>) => void
  }
}

const NAME_REGEX = /^[a-zA-Z0-9._-]+$/

const GITIGNORE_CONTENT = `node_modules/
dist/
.env
.env.local
.DS_Store
*.log
`

const TEMPLATES: Record<string, Record<string, string>> = {
  blank: {},
  "typescript-node": {
    "package.json": JSON.stringify(
      {
        name: "{{PROJECT_NAME}}",
        version: "1.0.0",
        type: "module",
        scripts: {
          build: "tsc",
          start: "node dist/index.js",
          dev: "tsx src/index.ts",
        },
        devDependencies: {
          typescript: "^5.0.0",
          tsx: "^4.0.0",
          "@types/node": "^20.0.0",
        },
      },
      null,
      2,
    ),
    "tsconfig.json": JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ES2022",
          moduleResolution: "bundler",
          outDir: "dist",
          rootDir: "src",
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          declaration: true,
        },
        include: ["src"],
      },
      null,
      2,
    ),
    "src/index.ts": `console.log("Hello from {{PROJECT_NAME}}!");\n`,
  },
  python: {
    "requirements.txt": "# Add your dependencies here\n",
    "main.py": `def main():\n    print("Hello from {{PROJECT_NAME}}!")\n\n\nif __name__ == "__main__":\n    main()\n`,
  },
  "react-vite": {
    "package.json": JSON.stringify(
      {
        name: "{{PROJECT_NAME}}",
        version: "0.1.0",
        type: "module",
        scripts: {
          dev: "vite",
          build: "tsc && vite build",
          preview: "vite preview",
        },
        dependencies: {
          react: "^18.2.0",
          "react-dom": "^18.2.0",
        },
        devDependencies: {
          "@types/react": "^18.2.0",
          "@types/react-dom": "^18.2.0",
          "@vitejs/plugin-react": "^4.0.0",
          typescript: "^5.0.0",
          vite: "^5.0.0",
        },
      },
      null,
      2,
    ),
    "vite.config.ts": `import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
})
`,
    "tsconfig.json": JSON.stringify(
      {
        compilerOptions: {
          target: "ES2020",
          module: "ESNext",
          moduleResolution: "bundler",
          jsx: "react-jsx",
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
        },
        include: ["src"],
      },
      null,
      2,
    ),
    "index.html": `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{{PROJECT_NAME}}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
    "src/App.tsx": `function App() {
  return (
    <div>
      <h1>{{PROJECT_NAME}}</h1>
      <p>Edit src/App.tsx to get started.</p>
    </div>
  )
}

export default App
`,
    "src/main.tsx": `import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App"

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
`,
  },
}

export function registerProjectRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { logger } = deps

  app.post<{ Body: ProjectInitRequest }>("/api/projects/init", async (request, reply) => {
    const { name, location, template, gitInit, createReadme } = request.body

    // Validate name
    if (!name || !NAME_REGEX.test(name)) {
      return reply.status(400).send({
        success: false,
        error: "Invalid project name. Use only alphanumeric characters, dots, hyphens, and underscores.",
        path: "",
        filesCreated: [],
        gitInitialized: false,
      } satisfies ProjectInitResponse)
    }

    // Validate template
    if (!TEMPLATES[template]) {
      return reply.status(400).send({
        success: false,
        error: `Unknown template: ${template}`,
        path: "",
        filesCreated: [],
        gitInitialized: false,
      } satisfies ProjectInitResponse)
    }

    // Expand ~ to home directory
    const expandedLocation = location.replace(/^~/, os.homedir())
    const projectPath = path.join(expandedLocation, name)

    // Check parent exists
    if (!fs.existsSync(expandedLocation)) {
      return reply.status(400).send({
        success: false,
        error: `Parent directory does not exist: ${location}`,
        path: "",
        filesCreated: [],
        gitInitialized: false,
      } satisfies ProjectInitResponse)
    }

    // Check project dir doesn't already exist
    if (fs.existsSync(projectPath)) {
      return reply.status(409).send({
        success: false,
        error: `Directory already exists: ${projectPath}`,
        path: projectPath,
        filesCreated: [],
        gitInitialized: false,
      } satisfies ProjectInitResponse)
    }

    try {
      // Create project directory
      fs.mkdirSync(projectPath, { recursive: true })
      const filesCreated: string[] = []

      // Write template files
      const templateFiles = TEMPLATES[template]!
      for (const [relativePath, content] of Object.entries(templateFiles)) {
        const filePath = path.join(projectPath, relativePath)
        const dir = path.dirname(filePath)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }
        const expanded = content.replace(/\{\{PROJECT_NAME\}\}/g, name)
        fs.writeFileSync(filePath, expanded, "utf-8")
        filesCreated.push(relativePath)
      }

      // Write README if requested
      if (createReadme) {
        const readmePath = path.join(projectPath, "README.md")
        fs.writeFileSync(readmePath, `# ${name}\n`, "utf-8")
        filesCreated.push("README.md")
      }

      // Git init if requested
      let gitInitialized = false
      if (gitInit) {
        try {
          execSync("git init", { cwd: projectPath, stdio: "pipe" })
          const gitignorePath = path.join(projectPath, ".gitignore")
          if (!fs.existsSync(gitignorePath)) {
            fs.writeFileSync(gitignorePath, GITIGNORE_CONTENT, "utf-8")
            filesCreated.push(".gitignore")
          }
          gitInitialized = true
        } catch (gitError) {
          logger.error("git init failed", { error: gitError, projectPath })
          // Non-fatal: project is still created
        }
      }

      logger.info("Project created", { name, template, projectPath, filesCreated })

      return reply.status(201).send({
        success: true,
        path: projectPath,
        filesCreated,
        gitInitialized,
      } satisfies ProjectInitResponse)
    } catch (error) {
      logger.error("Failed to create project", { error, name, projectPath })
      return reply.status(500).send({
        success: false,
        error: error instanceof Error ? error.message : "Failed to create project",
        path: projectPath,
        filesCreated: [],
        gitInitialized: false,
      } satisfies ProjectInitResponse)
    }
  })
}
