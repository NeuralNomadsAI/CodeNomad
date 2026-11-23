import {readFileSync} from 'node:fs'
import {ts,walk} from './component-inventory-ast.mjs'
export const overflowSource='packages/ui/src/components/instance/shell/right-panel/row-compact-actions.ts'
export function overflowSlop(text){
  const source=ts.createSourceFile('row-compact-actions.ts',text,ts.ScriptTarget.Latest,true)
  const values=[]
  walk(source,node=>{
    if(!ts.isBinaryExpression(node)||node.operatorToken.kind!==ts.SyntaxKind.GreaterThanToken||node.left.getText(source)!=='required')return
    const rhs=node.right
    if(!ts.isBinaryExpression(rhs)||rhs.operatorToken.kind!==ts.SyntaxKind.PlusToken||rhs.left.getText(source)!=='available'||!ts.isNumericLiteral(rhs.right))throw Error('Overflow requires available + numeric tolerance')
    values.push(Number(rhs.right.text))
  })
  if(values.length!==1)throw Error('Expected one Source overflow comparison')
  return values[0]
}
export const fileActionsHtml=`<div class="file-row-actions" id="file-actions-contract" data-slop="${overflowSlop(readFileSync(new URL('../../'+overflowSource,import.meta.url),'utf8'))}"><span class="file-row-pinned-actions"><button class="file-row-icon-button icon-toggle" aria-pressed="true"><svg></svg></button></span><span class="file-row-inline-actions"><button class="file-row-icon-button"><svg></svg></button></span></div>`
