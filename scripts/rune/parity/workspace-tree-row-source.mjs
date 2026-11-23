import {readFileSync} from 'node:fs'
import {ts,walk} from '../component-inventory-ast.mjs'
export const sourcePath='packages/ui/src/components/instance/shell/right-panel/components/WorkspaceTree.tsx'
export function workspaceRowContract(text){
  const source=ts.createSourceFile('WorkspaceTree.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
  const sizes=new Map(),indent=[]
  walk(source,node=>{
    if(!ts.isJsxOpeningElement(node)&&!ts.isJsxSelfClosingElement(node))return
    const tag=node.tagName.getText(source)
    for(const attr of node.attributes.properties){
      if(!ts.isJsxAttribute(attr))continue
      if(attr.name.getText(source)==='size'&&attr.initializer&&ts.isJsxExpression(attr.initializer)&&ts.isNumericLiteral(attr.initializer.expression))sizes.set(tag,Number(attr.initializer.expression.text))
      if(attr.name.getText(source)!=='style'||!attr.initializer||!ts.isJsxExpression(attr.initializer))continue
      const obj=attr.initializer.expression
      if(!ts.isObjectLiteralExpression(obj))continue
      for(const prop of obj.properties){
        if(!ts.isPropertyAssignment(prop)||prop.name.getText(source)!=='"padding-inline-start"')continue
        const value=prop.initializer
        if(!ts.isTemplateExpression(value)||value.head.text!==''||value.templateSpans.length!==1||value.templateSpans[0].literal.text!=='px')throw Error('Workspace row requires one px indent expression')
        const add=value.templateSpans[0].expression
        if(!ts.isBinaryExpression(add)||add.operatorToken.kind!==ts.SyntaxKind.PlusToken||!ts.isNumericLiteral(add.left)||!ts.isBinaryExpression(add.right)||add.right.operatorToken.kind!==ts.SyntaxKind.AsteriskToken||add.right.left.getText(source)!=='row.depth'||!ts.isNumericLiteral(add.right.right))throw Error('Workspace row requires base + row.depth * step')
        indent.push({base:Number(add.left.text),step:Number(add.right.right.text)})
      }
    }
  })
  if(indent.length!==1||!['ChevronRight','ChevronDown','RefreshCw','Icon','Folder','FolderOpen'].every(key=>sizes.has(key)))throw Error('Incomplete Workspace row Source contract')
  if(sizes.get('ChevronRight')!==sizes.get('ChevronDown'))throw Error('Chevron dimensions differ')
  if(sizes.get('Folder')!==sizes.get('Icon')||sizes.get('FolderOpen')!==sizes.get('Icon'))throw Error('Workspace icon dimensions differ')
  return {...indent[0],chevron:sizes.get('ChevronRight'),icon:sizes.get('Icon'),busy:sizes.get('RefreshCw')}
}
export const workspaceSource=workspaceRowContract(readFileSync(new URL('../../../'+sourcePath,import.meta.url),'utf8'))
export function workspaceRootIcon(text){
  const source=ts.createSourceFile('WorkspaceTree.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
  let glyph
  walk(source,node=>{
    if(!ts.isJsxElement(node)||!node.openingElement.attributes.properties.some(prop=>ts.isJsxAttribute(prop)
      &&prop.name.getText(source)==='class'&&prop.initializer?.getText(source)==='"workspace-tree-root"'))return
    const icon=node.children.find(child=>ts.isJsxSelfClosingElement(child)&&child.tagName.getText(source)==='FolderOpen')
    const size=icon?.attributes.properties.find(attr=>ts.isJsxAttribute(attr)&&attr.name.getText(source)==='size')?.initializer
    if(!size||!ts.isJsxExpression(size)||!size.expression||!ts.isNumericLiteral(size.expression)) throw Error('Workspace root requires its explicit folder icon size')
    glyph=Number(size.expression.text)
  })
  if(glyph===undefined)throw Error('Missing Workspace root icon')
  return glyph
}
