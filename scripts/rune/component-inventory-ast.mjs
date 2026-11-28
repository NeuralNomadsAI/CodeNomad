import {createRequire} from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
export const ts = require('typescript')
export const slash = value => value.replaceAll('\\', '/')
export const compareStrings = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
export const relativePath = (root, file) => slash(path.relative(root, file))
export const ordered = values => [...new Set(values)].sort(compareStrings)
export function walk(node, visit) {
  visit(node)
  ts.forEachChild(node, child => walk(child, visit))
}
export function reference(root, node) {
  const source = node.getSourceFile()
  return {file: relativePath(root, source.fileName), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1}
}
export function unalias(checker, symbol) {
  const seen = new Set()
  while (symbol && symbol.flags & ts.SymbolFlags.Alias && !seen.has(symbol)) {
    seen.add(symbol)
    symbol = checker.getAliasedSymbol(symbol)
  }
  return symbol
}
export function symbolName(checker, node) {
  return unalias(checker, checker.getSymbolAtLocation(node))?.getName() ?? node.getText()
}
export function functionOf(node) {
  if (ts.isFunctionDeclaration(node)) return node
  if (ts.isVariableDeclaration(node) && node.initializer) {
    let value = node.initializer
    while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isSatisfiesExpression(value)) value = value.expression
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return value
  }
}
export function componentsIn(source) {
  const found = []
  walk(source, node => {
    const fn = functionOf(node)
    if (!fn?.body || !node.name || !ts.isIdentifier(node.name) || !/^[A-Z]/.test(node.name.text)) return
    let jsx = false
    walk(fn.body, child => { if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) jsx = true })
    if (jsx || (ts.isVariableDeclaration(node) && /\b(Component|ParentComponent|FlowComponent)\b/.test(node.type?.getText() ?? ''))) found.push({node, fn, name: node.name.text})
  })
  return found
}
export function properties(checker, component, root) {
  const signature = checker.getSignaturesOfType(checker.getTypeAtLocation(component.node.name), ts.SignatureKind.Call)[0]
  const parameter = signature?.getParameters()[0]
  if (!parameter) return {type: null, fields: [], uncertainties: ['No props parameter resolved.']}
  const type = checker.getTypeOfSymbolAtLocation(parameter, component.node)
  const flags = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope
  return {
    type: checker.typeToString(type, component.node, flags),
    fields: checker.getPropertiesOfType(type).map(property => ({
      name: property.getName(), optional: Boolean(property.flags & ts.SymbolFlags.Optional),
      type: checker.typeToString(checker.getTypeOfSymbolAtLocation(property, component.node), component.node, flags),
      declarations: (property.declarations ?? []).filter(node => !slash(node.getSourceFile().fileName).split('/').includes('node_modules')).map(node => reference(root, node)),
    })).sort((a, b) => compareStrings(a.name, b.name)),
    uncertainties: type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) ? ['Props resolve to any/unknown; dependency or contextual typing requires review.'] : [],
  }
}
export function inspectBody(checker, component, root) {
  const states = [], translations = [], cssVariables = [], classes = [], dynamicClasses = []
  const translationNames = new Set(['t', 'tGlobal'])
  walk(component.fn, node => {
    if (ts.isBindingElement(node) && (node.propertyName?.getText() === 't' || node.name.getText() === 't')) translationNames.add(node.name.getText())
  })
  walk(component.fn, node => {
    if (ts.isCallExpression(node)) {
      const name = symbolName(checker, node.expression)
      if (['createSignal', 'createStore', 'createMemo', 'createResource', 'createMutable'].includes(name)) states.push({factory: name, binding: node.parent && ts.isVariableDeclaration(node.parent) ? node.parent.name.getText() : null, expression: node.getText(), ...reference(root, node)})
      if (translationNames.has(node.expression.getText()) || name === 'tGlobal') {
        const arg = node.arguments[0]
        translations.push({key: arg && ts.isStringLiteralLike(arg) ? arg.text : null, expression: arg?.getText() ?? '', ...reference(root, node)})
      }
    }
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      for (const match of node.text.matchAll(/var\(\s*(--[\w-]+)/g)) cssVariables.push({token: match[1], ...reference(root, node)})
    }
    if (!ts.isJsxAttribute(node)) return
    const name = node.name.getText()
    if (!['class', 'className', 'classList'].includes(name) || !node.initializer) return
    const strings = []
    if (ts.isStringLiteral(node.initializer)) strings.push(node.initializer)
    else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
      const expr = node.initializer.expression
      if (name === 'classList' && ts.isObjectLiteralExpression(expr)) {
        for (const property of expr.properties) {
          if (property.name && (ts.isStringLiteralLike(property.name) || ts.isIdentifier(property.name))) strings.push(property.name)
          else dynamicClasses.push({expression: property.getText(), ...reference(root, property)})
        }
      } else {
        walk(expr, child => {if (ts.isStringLiteralLike(child)) strings.push(child)})
        if (!ts.isStringLiteralLike(expr)) dynamicClasses.push({expression: expr.getText(), ...reference(root, expr)})
      }
    }
    for (const value of strings) for (const token of value.text.split(/\s+/).filter(Boolean)) classes.push({name: token, ...reference(root, value)})
  })
  return {states, translations, cssVariables, classes, dynamicClasses}
}
