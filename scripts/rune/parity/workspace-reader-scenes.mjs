export const readerScenes = {
  utf8: {path:'src/utf8.rs',text:'// Café · עברית · 日本語 · 🙂\r\nfn main() {\r\n    println!("reader");\r\n}\r\n'+Array.from({length:160},(_,n)=>`// line ${String(n).padStart(3,'0')} · synthetic`).join('\r\n')},
  empty: {path:'empty.txt',text:''},
  longline: {path:'long-line.txt',text:'Long Unicode line 🙂 '+ 'abcdef '.repeat(600)+'\nlast line\n'},
  bom: {path:'bom.txt',bytes:[239,187,191,65]},
  doublebom: {path:'double-bom.txt',bytes:[239,187,191,239,187,191,65]},
  malformed: {path:'malformed.txt',bytes:[240,40,140,40]},
  nul: {path:'nul.bin',bytes:[65,0,66]},
  markdown: {path:'README.md',text:'# Workspace reader\n\nCafé · עברית · 日本語 · 🙂\n\n**Bold** and `code`\n\n```rust\nfn demo() { println!("reader"); }\n```\n\n- first\n- second\n'},
  markdownAlias: {path:'notes.markdown',text:'# Markdown alias\n\nSynthetic text.\n'},
  mermaid: {path:'diagram.mmd',text:'flowchart TD\n  A[Reader] --> B[Source]\n'},
  mermaidError: {path:'unsupported.mmd',text:'unrecognisedDiagram\n  synthetic\n'},
  svg: {path:'image.svg',text:'<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#485f83"/><path d="M10 80L80 20L150 80" fill="none" stroke="#ffffff" stroke-width="8"/></svg>'},
  png: {path:'image.PNG',base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aokcAAAAASUVORK5CYII='},
  loading: {path:'loading.txt',text:'held content\n',hold:true},
  error: {path:'error.txt',text:'recovered\n',fail:true},
  conflict: {path:'conflict.txt',text:'baseline\n'},
}
export function sceneBytes(scene) {
  if(scene.bytes)return Uint8Array.from(scene.bytes)
  if(scene.base64)return Uint8Array.from(atob(scene.base64),c=>c.charCodeAt(0))
  return new TextEncoder().encode(scene.text)
}
