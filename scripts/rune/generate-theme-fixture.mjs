import {readFileSync} from 'node:fs'
import {ts,walk} from './component-inventory-ast.mjs'
import {workspaceSource} from './parity/workspace-tree-row-source.mjs'
const actionSource=readFileSync(new URL('../../packages/ui/src/components/action-overflow-menu.tsx',import.meta.url),'utf8')
export function sourceMenuGutter(text){
  const source=ts.createSourceFile('action-overflow-menu.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
  const values=[]
  walk(source,node=>{
    if(!ts.isJsxOpeningElement(node)||node.tagName.getText(source)!=='DropdownMenu')return
    const attribute=node.attributes.properties.find(value=>ts.isJsxAttribute(value)&&value.name.getText(source)==='gutter')
    const expression=attribute?.initializer
    if(!expression||!ts.isJsxExpression(expression)||!expression.expression||!ts.isNumericLiteral(expression.expression))throw Error('ActionOverflowMenu requires a numeric JSX gutter')
    values.push(Number(expression.expression.text))
  })
  if(values.length!==1)throw Error('ActionOverflowMenu requires one source DropdownMenu')
  return values[0]
}
const gutter=sourceMenuGutter(actionSource)
const workspace=`<div class="workspace-tree-row" tabindex="0" data-source='${JSON.stringify(workspaceSource)}'><span class="workspace-tree-label">File</span><span class="animate-spin"></span></div>`
const git=`<section class="git-panel"><header class="git-panel-context"></header><div class="git-panel-tools"><span class="git-panel-count">1 file</span></div><button class="git-history-row">Commit</button><button class="git-change-section-header"><span class="git-change-section-title">Changes</span><span class="git-change-section-count">1</span></button></section>`
// Shared source fixture for theme generation and browser contract qualification.
export const themeFixtureHtml='<!doctype html><html><head><link rel="stylesheet" href="/src/index.css?direct"></head><body><div class="window-shell"><div class="window-header"><span class="window-title">Theme</span><button class="window-icon-button"><svg viewBox="0 0 24 24"></svg></button></div></div><button class="button-primary"></button><button class="button-secondary"></button><input class="selector-input"><span class="disclosure-chevron"></span><span class="transition-colors"></span><div class="tab-bar-instance"><div class="tab-container"><div class="tab-strip"><div class="tab-strip-tabs"><div class="tab-draggable"><div><button class="tab-base tab-active"><svg class="w-4 h-4"></svg><span class="tab-label">Alpha</span><span class="tab-close" tabindex="0"><svg class="w-3 h-3"></svg></span></button></div></div><div class="tab-draggable"><div><button class="tab-base tab-inactive"><svg class="w-4 h-4"></svg><span class="tab-label">Beta</span></button></div></div></div></div></div></div><div class="action-overflow-content"><div class="action-overflow-item"><span class="action-overflow-item-icon"></span><span class="action-overflow-item-label">Action</span></div><div class="action-overflow-item" data-disabled><span class="action-overflow-item-icon"></span><span class="action-overflow-item-label">Disabled</span></div></div><div class="file-row-actions"><button class="file-row-icon-button"><svg></svg></button></div></body></html>'.replace('class="action-overflow-content"',`class="action-overflow-content" data-source-gutter="${gutter}"`).replace('</body>',workspace+git+'</body>')
