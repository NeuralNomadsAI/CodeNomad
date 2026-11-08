"""Loopback-only native browser acceptance page; logs results to stdout."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
import base64

PDF_BASE64 = 'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgMjAwXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggNDkgPj4Kc3RyZWFtCkJUIC9GMSAxNiBUZiAzMCAxMDAgVGQgKE5hdGl2ZSBwcmV2aWV3IFBERikgVGogRVQKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDMxMSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQxMAolJUVPRgo='

PAGE = b'''<!doctype html><meta charset="utf-8"><title>WebKit capabilities</title>
<style>body{font:18px sans-serif}button,a{display:inline-block;margin:4px;padding:6px}details{margin-block:12px}pre{white-space:pre-wrap}</style>
<button onclick="window.popup=window.open('/popup','oauth','width=520,height=680')">OAuth popup</button>
<a href="/popup" target="_blank" rel="opener">Target blank</a>
<a href="/download" download>Download</a>
<button onclick="alert('fixture alert');report('alert','dismissed');report('confirm',confirm('fixture confirm'));report('prompt',prompt('fixture prompt','fixture-default'))">Dialogs</button>
<button onclick="permissions()">Permissions</button>
<button onclick="window.open('file:///etc/passwd')">Blocked file popup</button>
<button onclick="popup=window.open('/hold','hold')">Hold popup for opener cleanup</button>
<button onclick="window.open('/lifetime-child')">Lifetime tree</button>
<a href="data:text/plain,generated-download" download="capabilities-data.txt">Data download</a>
<button onclick="blobDownload()">Blob download</button>
<details open><summary>Browser APIs</summary>
<button onclick="blankPopup()">Blank OAuth</button>
<button onclick="const first=window.open('/hold','named-test');const second=window.open('/popup','named-test');report('named',first===second)">Named window</button>
<button onclick="try{report('prompt-only',prompt('fixture prompt','fixture-default'))}catch(e){report('prompt-error',e.message)}">Prompt only</button>
<button onclick="document.documentElement.requestFullscreen().then(()=>report('fullscreen','entered'),e=>report('fullscreen',e.name))">Fullscreen</button>
<button onclick="this.requestPointerLock()">Pointer lock</button>
<button onclick="navigator.clipboard.readText().then(v=>report('clipboard-read','length:'+v.length),e=>report('clipboard-read',e.name))">Read clipboard</button>
<button onclick="navigator.clipboard.writeText('capabilities-fixture').then(()=>report('clipboard-write','written'),e=>report('clipboard-write',e.name))">Write clipboard</button>
<button onclick="window.onbeforeunload=()=>true;report('beforeunload','armed');report('activation',navigator.userActivation?.hasBeenActive)">Arm beforeunload</button><a href="/next">Navigate</a>
<button onclick="location.reload()">Reload page</button>
<button onclick="window.open('/close-test','close-test','width=800,height=700')">Close-test popup</button>
<button onclick="window.print();report('print','requested')">Print</button>
<input type="file" onchange="report('file',this.files[0]?.name)">
<div style="height:80px;border:1px solid" ondragenter="report('drag-enter',Array.from(event.dataTransfer.types).join(','))" ondragover="event.preventDefault();event.dataTransfer.dropEffect='copy'" ondrop="event.preventDefault();report('drop-count',event.dataTransfer.files.length);report('drop',event.dataTransfer.files[0]?.name)">Drop file</div>
<button onclick="if(window.PublicKeyCredential)PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().then(v=>report('webauthn',v));else report('webauthn','unavailable')">WebAuthn availability</button>
<button onclick="report('hardware',JSON.stringify(Object.fromEntries(['usb','hid','serial','bluetooth'].map(k=>[k,typeof navigator[k]]))))">Hardware APIs</button>
<a href="/pdf" target="_blank">PDF display</a><a href="/pdf-download" download>PDF download</a>
</details>
<a href="/controls">Additional controls</a>
<pre id="results"></pre><script>
function report(k,v){results.textContent+=k+': '+v+'\\n';fetch('/result?'+encodeURIComponent(k+'='+v))}
addEventListener('error',e=>report('error',e.message));
document.addEventListener('pointerlockchange',()=>report('pointer-lock',Boolean(document.pointerLockElement)));
document.addEventListener('pointerlockerror',()=>report('pointer-lock','error'));
let lockedMotions=0;
document.addEventListener('mousemove',event=>{if(document.pointerLockElement&&(event.movementX||event.movementY)&&lockedMotions++<3)report('locked-motion',event.movementX+','+event.movementY)});
document.addEventListener('fullscreenchange',()=>report('fullscreen-state',Boolean(document.fullscreenElement)));
function blankPopup(){
  popup=window.open('about:blank','blank-oauth','width=520,height=680');
  report('blank-opener',popup?.opener===window);
  if(popup){popup.document.write('<button id="finish">Finish blank OAuth</button>');popup.document.getElementById('finish').onclick=()=>{popup.opener.postMessage('blank-roundtrip',location.origin);popup.close()}}
}
function blobDownload(){
  const api=typeof URL.createObjectURL==='function'?URL:window.webkitURL;
  if(!api?.createObjectURL){report('blob','unavailable');return}
  const a=document.createElement('a');a.href=api.createObjectURL(new Blob(['generated-download'],{type:'application/octet-stream'}));a.download='capabilities-blob.txt';document.body.append(a);a.click();a.remove();report('blob','requested');
}
function permissions(){
  navigator.geolocation.getCurrentPosition(()=>report('geo','GRANTED'),e=>report('geo',e.code));
  if(navigator.mediaDevices?.getUserMedia)navigator.mediaDevices.getUserMedia({audio:true,video:true}).then(()=>report('media','GRANTED'),e=>report('media',e.name));else report('media','unavailable');
  if('Notification' in window)Notification.requestPermission().then(v=>report('notifications',v));else report('notifications','unavailable');
}
localStorage.fixture='shared';document.cookie='fixture=shared; SameSite=Lax';
report('isolation',typeof window.__TAURI_INTERNALS__+'/'+typeof window.require+'/'+typeof URL.createObjectURL);
addEventListener('message',e=>{if(e.origin===location.origin){report('oauth',e.data);setTimeout(()=>report('closed',popup?.closed),300)}});
</script>'''
POPUP = b'''<!doctype html><title>OAuth fixture</title><button onclick="if(opener)opener.postMessage('roundtrip:'+localStorage.fixture+':'+document.cookie,location.origin);window.close()">Finish OAuth</button>'''
LIFETIME = b'''<!doctype html><title>Lifetime child</title><button onclick="onbeforeunload=()=>true;window.open('/hold');fetch('/result?lifetime-child=armed')">Create descendant</button>'''
CONTROLS = b'''<!doctype html><meta charset="utf-8"><title>Additional controls</title>
<style>body{font:18px sans-serif}button,input,a{margin:6px;padding:6px}img{width:120px;height:80px}pre{white-space:pre-wrap}</style>
<button onclick="navigator.clipboard.writeText('fixture-clipboard').then(()=>report('write','ok'),e=>report('write',e.name))">Write clipboard</button>
<button onclick="navigator.clipboard.readText().then(v=>report('read',v),e=>report('read',e.name))">Read clipboard</button><br>
<input aria-label="Copy source" value="fixture-native-copy"><input aria-label="Paste target" oninput="report('paste',this.value)"><br>
<input aria-label="Select fixture file" type="file" onchange="report('file',this.files[0]?.name)"><br>
<a href="/hold" target="_blank">Context link</a><br>
<a href="/hold" target="_blank"><img alt="Context image" src="/image.png"></a><br>
<a href="/pdf" target="_blank">PDF display</a>
<button onclick="report('apis',JSON.stringify(Object.fromEntries(['usb','hid','serial','bluetooth'].map(k=>[k,typeof navigator[k]]))))">Hardware APIs</button>
<pre id="results"></pre><script>
function report(k,v){results.textContent+=k+': '+v+'\\n';fetch('/result?'+encodeURIComponent(k+'='+v))}
addEventListener('resize',()=>report('viewport',innerWidth+'x'+innerHeight+':'+devicePixelRatio));
</script>'''

class Handler(BaseHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.end_headers()

    def do_GET(self):
        route = urlsplit(self.path).path
        if route == '/image.png':
            body = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==')
            self.send_response(200)
            self.send_header('Content-Type', 'image/png')
            self.end_headers()
            self.wfile.write(body)
            return
        if route in ('/pdf', '/pdf-download'):
            body = base64.b64decode(PDF_BASE64)
            self.send_response(200)
            self.send_header('Content-Type', 'application/pdf')
            if route == '/pdf-download':
                self.send_header('Content-Disposition', 'attachment; filename="capabilities-fixture.pdf"')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if route == '/download':
            body = b'webkit-capabilities-download\n'
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Disposition', 'attachment; filename="capabilities-fixture.txt"')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        body = CONTROLS if route == '/controls' else LIFETIME if route == '/lifetime-child' else POPUP if route == '/popup' else b'<title>Held popup</title>held' if route == '/hold' else PAGE
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 18741), Handler).serve_forever()
