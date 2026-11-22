import {mkdir,writeFile} from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const root=path.resolve(import.meta.dirname,'../../..')
const cases=[]
for(const [name,width,height,format] of [
  ['small.png',8,4,'png'],['large.png',2048,1536,'png'],['sample.avif',24,12,'avif'],
]){
  const image=sharp({create:{width,height,channels:4,background:{r:32,g:96,b:160,alpha:1}}})
  const bytes=await image[format]().toBuffer()
  cases.push({name,width,height,base64:bytes.toString('base64')})
}
const svg='<svg xmlns="http://www.w3.org/2000/svg" width="16" height="8"><rect width="16" height="8" fill="#2060a0"/></svg>'
cases.push({name:'sample.svg',width:16,height:8,base64:Buffer.from(svg).toString('base64')})
const documents=[
  ['markup.md','# Reader\n\n**safe** [remote](https://example.invalid/never)\n\n![blocked](https://example.invalid/image.png)\n\n<script>never_execute()</script>'],
  ['valid.mmd','flowchart LR\n A-->B\n'],['unsupported.mmd','unknownDiagram\n A-->B\n'],
  ['unreadable.mmd','flowchart LR\n'],
  ['nul.bin',Buffer.from([0,1,255])],['broken.png',Buffer.from('malformed image')],
].map(([name,text])=>({name,base64:Buffer.from(text).toString('base64')}))
const target=path.join(root,'packages/rune-app/tests/fixtures/reader-content.json')
await mkdir(path.dirname(target),{recursive:true})
await writeFile(target,JSON.stringify({encoder:{sharp:sharp.versions.sharp,vips:sharp.versions.vips},images:cases,documents},null,2)+'\n')
console.log(target)
