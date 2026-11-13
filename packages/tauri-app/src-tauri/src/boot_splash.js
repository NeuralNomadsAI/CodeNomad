;(() => {
  // Static boot splash for the local window's initial about:blank document.
  // Windows maps the custom protocol onto the network stack, where every
  // request (loading.html included) waits for proxy/PAC resolution; about:blank
  // is created with no network activity, so this paints at t=0 and covers the
  // wait. The first real navigation replaces it. The script also runs on every
  // later document and subframe: the guard keeps it a no-op there.
  if (window.top !== window) return
  if (window.location.href !== 'about:blank') return
  if (window.__CODENOMAD_BOOT__) return
  window.__CODENOMAD_BOOT__ = true

  // Visual copy of loading.html's initial state (loading.css + dark tokens).
  const style = document.createElement('style')
  style.textContent = `
    :root { color-scheme: dark; }
    html, body { height: 100%; margin: 0; }
    body {
      background-color: #1a1a1a;
      color: #cfd4dc;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    #codenomad-boot {
      min-height: 100vh;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 24px;
      padding: 32px;
      text-align: center;
    }
    #codenomad-boot .boot-logo {
      height: 5.3rem;
      width: auto;
      filter: drop-shadow(0 20px 60px rgba(0, 0, 0, 0.45));
    }
    #codenomad-boot .boot-title {
      margin: 0;
      font-size: 2.8rem;
      font-weight: 600;
      color: #cfd4dc;
    }
    #codenomad-boot .boot-spinner {
      box-sizing: border-box;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      border: 2px solid rgba(255, 255, 255, 0.18);
      border-top-color: #0080ff;
      animation: codenomad-boot-spin 0.9s linear infinite;
    }
    @keyframes codenomad-boot-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `

  // Zero network dependencies: the logo is the checked-in on-dark SVG,
  // inlined verbatim, and the spinner is pure CSS.
  const splash = document.createElement('div')
  splash.id = 'codenomad-boot'
  splash.setAttribute('role', 'status')
  splash.innerHTML = `
    <svg class="boot-logo" xmlns="http://www.w3.org/2000/svg" viewBox="-100 -115.47 200 230.94" aria-hidden="true" focusable="false">
      <path fill="#000" d="M0 -104.973 L90.909 -52.486 L90.909 52.486 L0 104.973 L-90.909 52.486 L-90.909 -52.486Z"/>
      <path fill="#fff" fill-rule="evenodd" d="M0 -115.47 L100 -57.735 L100 57.735 L0 115.47 L-100 57.735 L-100 -57.735ZM-81.818 -47.238 L-81.818 47.238 L0 94.475 L81.818 47.238 L81.818 -47.238 L0 -94.475ZM-9.091 -68.232 L-63.636 -36.74 L-63.636 36.74 L-9.091 68.232 L-9.091 9.091 L-27.273 9.091 L-27.273 36.74 L-45.455 26.243 L-45.455 -26.243 L-27.273 -36.74 L-27.273 -9.091 L-9.091 -9.091ZM9.091 -68.232 L63.636 -36.74 L63.636 36.74 L45.455 47.238 L45.455 -26.243 L27.273 -36.74 L27.273 57.735 L9.091 68.232Z"/>
    </svg>
    <h1 class="boot-title">CodeNomad</h1>
    <div class="boot-spinner" aria-hidden="true"></div>
  `

  const mount = () => {
    document.title = 'CodeNomad'
    ;(document.head || document.documentElement).appendChild(style)
    ;(document.body || document.documentElement).appendChild(splash)
  }

  if (document.body) {
    mount()
  } else {
    document.addEventListener('DOMContentLoaded', mount, { once: true })
  }
})()
