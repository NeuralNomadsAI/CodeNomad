// Runs in the isolated PNG-decoding page. Mutations affect the candidate region only.
export async function measureWorkspaceRow({images,boxes,mode}){
  const [source,candidate,wrongGlyph,unselected]=await __codenomadReadPngs(images)
  if(source.width!==candidate.width||source.height!==candidate.height)throw Error('Image sizes differ')
  const width=source.width,height=source.height
  const bounds={chevron:boxes[0],icon:boxes[1],text:boxes[2],actions:boxes.at(-1),busy:boxes.length===5?boxes[3]:[0,0,0,0]}
  const inside=(x,y,r)=>x>=r[0]&&y>=r[1]&&x<r[0]+r[2]&&y<r[1]+r[3]
  const regionAt=(x,y)=>x===0||y===0||x===width-1||y===height-1?'edge':['chevron','icon','text','busy','actions'].find(key=>inside(x,y,bounds[key]))||'surface'
  const indices=Object.fromEntries(['surface','chevron','icon','text','busy','actions','edge'].map(key=>[key,[]]))
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)indices[regionAt(x,y)].push((y*width+x)*4)
  const stats=(pixels,key)=>{
    let different=0,errorSum=0,maxError=0
    for(const i of indices[key]){
      let sum=0
      for(let c=0;c<4;c++){const d=Math.abs(source.pixels[i+c]-pixels[i+c]);sum+=d;maxError=Math.max(maxError,d)}
      different+=sum>0;errorSum+=sum
    }
    return {pixels:indices[key].length,different,errorSum,maxError}
  }
  const regions=Object.fromEntries(Object.keys(indices).map(key=>[key,stats(candidate.pixels,key)]))
  const controls=[]
  const bg=[...candidate.pixels.slice((15*width+5)*4,(15*width+5)*4+4)]
  const change=(name,key,transform)=>{
    if(!indices[key].length)throw Error('Control region absent: '+name)
    const pixels=new Uint8ClampedArray(candidate.pixels)
    for(const i of indices[key]){
      const x=(i/4)%width,y=Math.floor(i/4/width),rgba=transform(x,y,i)
      for(let c=0;c<4;c++)pixels[i+c]=rgba[c]
    }
    controls.push({name,region:key,measured:stats(pixels,key),changedPixels:indices[key].filter(i=>[0,1,2,3].some(c=>pixels[i+c]!==candidate.pixels[i+c])).length})
  }
  const absent=key=>change('absent-'+key,key,()=>bg)
  const shifted=key=>{
    const r=bounds[key]
    change('shifted-'+key,key,(x,y)=>inside(x-1,y,r)?candidate.pixels.slice((y*width+x-1)*4,(y*width+x-1)*4+4):bg)
  }
  if(mode!=='file'){
    absent('chevron');shifted('chevron')
    if(mode!=='open'){
      const r=bounds.chevron
      change('wrong-mirror-chevron','chevron',(x,y)=>{const xx=Math.round(r[0]*2+r[2]-1-x);return candidate.pixels.slice((y*width+xx)*4,(y*width+xx)*4+4)})
    }
  }
  absent('icon');shifted('icon')
  change('wrong-source-glyph','icon',(x,y)=>{
    const r=bounds.icon,xx=x-r[0]+39,yy=y-r[1]+8,i=(yy*width+xx)*4
    return wrongGlyph.pixels.slice(i,i+4)
  })
  absent('text');shifted('text')
  change('altered-surface','surface',(_x,_y,i)=>[...candidate.pixels.slice(i,i+3)].map(v=>v<128?v+8:v-8).concat(255))
  if(mode==='open'||mode==='focus')change('absent-selected-surface','surface',()=>unselected.pixels.slice((15*width+5)*4,(15*width+5)*4+4))
  change('altered-edge','edge',(_x,_y,i)=>[...candidate.pixels.slice(i,i+3)].map(v=>v<128?v+8:v-8).concat(255))
  if(mode==='focus'){absent('edge');absent('actions')}
  if(mode==='busy'){absent('busy');shifted('busy')}
  return {regions,controls,regionPixels:Object.values(indices).reduce((n,a)=>n+a.length,0),totalPixels:width*height,
    exclusions:mode==='open'?['Mirroring a downward chevron preserves its symmetric Source shape; wrong-mirror control applies to closed folders.']:mode==='file'?['Files have the Source empty chevron spacer; chevron mutation controls apply to folders.']:[]}
}
