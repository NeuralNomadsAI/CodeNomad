const { app, BrowserWindow } = require("electron")
const { setBrowserEmulation } = require(process.env.CODENOMAD_EMULATION_MODULE)
app.setPath("userData", process.env.CODENOMAD_TEST_PROFILE)
app.whenReady().then(() => {
  const window = new BrowserWindow({ show: false, width: 1100, height: 950,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  globalThis.emulationFixture = {
    apply: preset => setBrowserEmulation(window.webContents, preset),
    contentSize: () => window.getContentSize(),
    snapshot: () => window.webContents.executeJavaScript(`({ width: innerWidth, height: innerHeight,
      dpr: devicePixelRatio, coarse: matchMedia('(pointer: coarse)').matches,
      hover: matchMedia('(hover: hover)').matches, mobile: navigator.userAgentData.mobile,
      ua: navigator.userAgent, platform: navigator.platform, hintPlatform: navigator.userAgentData.platform,
      screenWidth: screen.width, screenHeight: screen.height,
      touch: navigator.maxTouchPoints, orientation: screen.orientation.type })`),
    accessibility: async () => {
      const debuggerSession = window.webContents.debugger
      await debuggerSession.sendCommand("Accessibility.enable")
      await debuggerSession.sendCommand("Accessibility.getFullAXTree")
    },
  }
  window.loadURL(process.env.CODENOMAD_EMULATION_URL)
})
app.on("window-all-closed", () => app.quit())
