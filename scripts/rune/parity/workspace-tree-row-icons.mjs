import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import path from 'node:path'
import {ts,walk} from '../component-inventory-ast.mjs'
import {generated} from '../generate-common.mjs'
const require=createRequire(import.meta.url)
const glyphs=['chevron-right','chevron-down','refresh-cw','folder','folder-open','file','file-code','file-text','image','copy','eye']
const gitGlyphs=['plus','minus','git-branch','git-commit-horizontal','columns','rows','fold-vertical','unfold-vertical','wrap-text','arrow-left','more-horizontal']
function literal(node){
  if(ts.isStringLiteral(node)||ts.isNumericLiteral(node))return node.text
  if(ts.isArrayLiteralExpression(node))return node.elements.map(literal)
  if(ts.isObjectLiteralExpression(node))return Object.fromEntries(node.properties.map(prop=>{
    if(!ts.isPropertyAssignment(prop))throw Error('Icon object must contain literal properties')
    return [prop.name.getText().replace(/^['"]|['"]$/g,''),literal(prop.initializer)]
  }))
  throw Error('Nonliteral Lucide icon contract')
}
export async function generateWorkspaceIcons(){
  await writeIcons('src/workspace_tree_icons.rs',glyphs)
  await writeIcons('src/git_panel_icons.rs',gitGlyphs)
}
async function writeIcons(output,glyphs){
  const folder=path.join(path.dirname(require.resolve('lucide-solid')),'../source/icons')
  const lines=['//! Generated from the installed Source Lucide dependency by generate-theme.mjs.','use rune::Icon;']
  for(const name of glyphs){
    const source=ts.createSourceFile(name+'.jsx',await readFile(path.join(folder,name+'.jsx'),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JSX)
    let nodes;walk(source,node=>{if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='iconNode')nodes=literal(node.initializer)})
    if(!nodes?.length)throw Error('Missing Lucide iconNode '+name)
    const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;')
    const body='<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'+nodes.map(([tag,attrs])=>{
      if(!['path','polyline','line','rect','circle','polygon','ellipse'].includes(tag))throw Error('Unsupported SVG primitive '+tag)
      return `<${tag} ${Object.entries(attrs).filter(([k])=>k!=='key').map(([k,v])=>`${k}="${escape(v)}"`).join(' ')}/>`
    }).join('')+'</g>'
    lines.push(`#[rustfmt::skip]\npub static ${name.toUpperCase().replaceAll('-','_')}: Icon = Icon { name: "lucide-${name}", view: 24.0, body: r#"${body}"# };`)
  }
  await generated(output,lines.join('\n')+'\n')
}
