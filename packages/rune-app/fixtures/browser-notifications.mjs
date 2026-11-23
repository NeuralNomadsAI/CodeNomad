import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import path from 'node:path'
import {chromium} from 'playwright'

const bundle = process.argv[2]
assert(bundle && path.isAbsolute(bundle), 'Pass the absolute wasm-bindgen output directory')
const assets = new Map([
  ['/probe.js', ['text/javascript', await readFile(path.join(bundle, 'probe.js'))]],
  ['/probe_bg.wasm', ['application/wasm', await readFile(path.join(bundle, 'probe_bg.wasm'))]],
])
const server = createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, {'Content-Type': 'text/html'}).end('<!doctype html><button>Request permission</button>')
  } else if (assets.has(req.url)) {
    const [type, bytes] = assets.get(req.url)
    res.writeHead(200, {'Content-Type': type}).end(bytes)
  } else res.writeHead(404).end()
})
await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await chromium.launch({headless: true, executablePath: process.env.CODENOMAD_BROWSER_PATH})
  const page = await browser.newPage()
  await page.addInitScript(() => {
    const proof = window.noticeProof = {asked: [], shown: [], closed: 0, focused: 0}
    window.focus = () => proof.focused++
    window.Notification = class {
      static permission = 'default'
      static requestPermission() {
        proof.asked.push(navigator.userActivation.isActive)
        this.permission = 'granted'
        return Promise.resolve('granted')
      }
      constructor(title, {body}) {
        proof.shown.push({title, body})
        proof.last = this
      }
      close() { proof.closed++ }
    }
  })
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  const before = await page.evaluate(async () => {
    const probe = window.probe = await import('/probe.js')
    await probe.default()
    document.querySelector('button').onclick = () => probe.request()
    return {sent: probe.send(), asked: noticeProof.asked}
  })
  assert.deepEqual(before, {sent: false, asked: []})
  await page.getByRole('button').click()
  const proof = await page.evaluate(() => {
    const sent = probe.send()
    noticeProof.last.onclick(new Event('click'))
    noticeProof.last.onclick(new Event('click'))
    probe.revoke()
    const revoked = typeof noticeProof.last.onclick !== 'function'
    Notification.permission = 'denied'
    const denied = probe.send()
    delete window.Notification
    const unavailable = probe.send()
    const {asked, shown, closed, focused} = noticeProof
    return {sent, denied, unavailable, asked, shown, closed, focused, revoked, clicks: probe.clicks()}
  })
  assert.deepEqual(proof, {
    sent: true, denied: false, unavailable: false, asked: [true],
    shown: [{title: 'Private project', body: 'Question'}], closed: 1, focused: 1, revoked: true, clicks: 1,
  })
  console.log(JSON.stringify({kind: 'browser-notifications', ...proof}))
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
