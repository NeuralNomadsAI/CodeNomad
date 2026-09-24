const { app, BrowserWindow } = require("electron")
app.setPath("userData", process.env.CODENOMAD_TEST_PROFILE)
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1100, height: 800, webPreferences: { contextIsolation: true, nodeIntegration: false } })
  void window.loadURL(process.env.CODENOMAD_TEST_URL)
})
