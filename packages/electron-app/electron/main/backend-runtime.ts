/** Runs Electron's executable as plain Node for the backend. ELECTRON_NO_ASAR turns
 * off Electron's `.asar` archive handling in fs, so project files named `*.asar`
 * stay ordinary files; the backend loads nothing from app.asar (its server lives
 * in resources/server). Both variables reach the server runtime child and npm. */
export const BACKEND_RUNTIME_ENVIRONMENT: Readonly<Record<"ELECTRON_RUN_AS_NODE" | "ELECTRON_NO_ASAR", string>> = {
  ELECTRON_RUN_AS_NODE: "1",
  ELECTRON_NO_ASAR: "1",
}
