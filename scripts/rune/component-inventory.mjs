import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {existsSync} from 'node:fs'
import {readFile, readdir, mkdir, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {ts, slash, compareStrings, relativePath, ordered, walk, reference, unalias, componentsIn, properties, inspectBody} from './component-inventory-ast.mjs'

const require = createRequire(import.meta.url)
const postcss = require('postcss')
const selectors = require('postcss-selector-parser')
export const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export function canonicalPath(file, root = defaultRoot) {
  const normalized = slash(file)
  const rootPrefix = slash(root).replace(/\/+$/, '') + '/'
  if (normalized.startsWith(rootPrefix)) return normalized.slice(rootPrefix.length)
  if (!path.isAbsolute(file) && !/^[A-Za-z]:\//.test(normalized) && !normalized.startsWith('/')) {
    return normalized.replace(/^\.\//, '')
  }
  return relativePath(root, file)
}
export function sortPaths(files, root = defaultRoot) {
  return [...files].sort((a, b) => compareStrings(canonicalPath(a, root), canonicalPath(b, root)))
}
export async function lockfileMismatches(root = defaultRoot) {
  const lockPath = path.join(root, 'package-lock.json')
  const nodeModulesPath = path.join(root, 'node_modules')
  if (!existsSync(lockPath) || !existsSync(nodeModulesPath)) return []
  const lock = JSON.parse(await readFile(lockPath, 'utf8'))
  const mismatches = []
  for (const [pkgPath, meta] of Object.entries(lock.packages ?? {})) {
    if (!pkgPath.startsWith('node_modules/') || meta?.link || !meta?.version) continue
    const pkgJsonPath = path.join(root, pkgPath, 'package.json')
    if (!existsSync(pkgJsonPath)) continue
    try {
      const installed = JSON.parse(await readFile(pkgJsonPath, 'utf8')).version
      if (installed && installed !== meta.version) {
        mismatches.push({pkg: pkgPath.slice('node_modules/'.length), installed, expected: meta.version})
      }
    } catch {}
  }
  return mismatches.sort((a, b) => compareStrings(a.pkg, b.pkg))
}
function formatMismatches(mismatches) {
  const sample = mismatches.slice(0, 5).map(({pkg, installed, expected}) => `${pkg}: installed ${installed}, lockfile ${expected}`).join('; ')
  return mismatches.length > 5 ? `${sample}; +${mismatches.length - 5} more` : sample
}
function normalize(value, root = defaultRoot) {
  if (typeof value === 'string') {
    const slashed = slash(root) + '/'
    let out = value.replaceAll('\r\n', '\n').replaceAll(slashed, '').replaceAll(root + path.sep, '')
    if (/^[A-Za-z]:\//.test(slashed)) {
      const toggled = (slashed[0] === slashed[0].toLowerCase() ? slashed[0].toUpperCase() : slashed[0].toLowerCase()) + slashed.slice(1)
      out = out.replaceAll(toggled, '')
    }
    return out
  }
  if (Array.isArray(value)) return value.map(child => normalize(child, root))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalize(child, root)]))
  return value
}
async function digest(file) {
  const bytes = await readFile(file)
  const input = /\.(?:[cm]?[jt]sx?|css|json|html|md|txt|svg|ya?ml)$/.test(file) ? bytes.toString('utf8').replaceAll('\r\n', '\n') : bytes
  return createHash('sha256').update(input).digest('hex')
}
function importEvidence(sources, root) {
  const external = [], unresolved = []
  for (const source of sources) walk(source, node => {
    if ((!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) || !node.moduleSpecifier || !ts.isStringLiteralLike(node.moduleSpecifier)) return
    const specifier = node.moduleSpecifier.text
    const evidence = {specifier, ...reference(root, node.moduleSpecifier)}
    if (!specifier.startsWith('.') && !specifier.startsWith('@/') && !specifier.startsWith('/src/')) {
      external.push({...evidence, resolution: 'external-dependency-requires-installed-contract'})
      return
    }
    const base = specifier.startsWith('@/') ? path.join(root, 'packages/ui/src', specifier.slice(2)) : specifier.startsWith('/src/') ? path.join(root, 'packages/ui', specifier) : path.resolve(path.dirname(source.fileName), specifier)
    const clean = base.split('?')[0], stem = clean.replace(/\.[cm]?js$/, '')
    if (![clean, ...['.ts', '.tsx', '.d.ts', '.js', '.jsx', '/index.ts', '/index.tsx'].map(extension => stem + extension)].some(candidate => existsSync(candidate))) unresolved.push({...evidence, resolution: 'internal-path-unresolved'})
  })
  return {external, unresolved}
}
async function filesUnder(directory, root = directory) {
  const result = []
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    if (['node_modules', 'dist', '.git'].includes(entry.name)) continue
    const file = path.join(directory, entry.name)
    if (slash(file).endsWith('/packages/ui/src/renderer/public/monaco')) continue
    if (entry.isDirectory()) result.push(...await filesUnder(file, root))
    else result.push(file)
  }
  return sortPaths(result, root)
}
async function cssIndex(root, files) {
  const classes = new Map(), tokens = new Map()
  for (const file of sortPaths(files.filter(file => file.endsWith('.css')), root)) {
    const tree = postcss.parse((await readFile(file, 'utf8')).replaceAll('\r\n', '\n'), {from: file})
    tree.walkDecls(declaration => {
      if (!declaration.prop.startsWith('--')) return
      const evidence = {file: relativePath(root, file), line: declaration.source.start.line, value: declaration.value}
      tokens.set(declaration.prop, [...tokens.get(declaration.prop) ?? [], evidence])
    })
    tree.walkRules(rule => {
      const names = []
      try { selectors(nodes => nodes.walkClasses(node => names.push(node.value))).processSync(rule.selector) } catch { return }
      const variables = ordered([...rule.toString().matchAll(/var\(\s*(--[\w-]+)/g)].map(match => match[1]))
      for (const name of ordered(names)) classes.set(name, [...classes.get(name) ?? [], {file: relativePath(root, file), line: rule.source.start.line, selector: rule.selector, variables}])
    })
  }
  return {classes, tokens}
}
function resolveModule(program, checker, declaration, root) {
  const specifier = declaration.moduleSpecifier
  if (!specifier || !ts.isStringLiteralLike(specifier)) return null
  const symbol = checker.getSymbolAtLocation(specifier)
  const source = symbol?.declarations?.find(ts.isSourceFile)
  if (source && program.getSourceFile(source.fileName)) return slash(path.relative(root, source.fileName))
  return null
}
function evidenceGraph(program, checker, sources, root, componentSymbols) {
  const imports = new Map(), usages = new Map(), exports = new Map(), edges = new Map()
  const knownSources = new Set(sources.map(source => slash(path.relative(root, source.fileName))))
  for (const source of sources) {
    const file = slash(path.relative(root, source.fileName)), dependencies = []
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue
      const target = resolveModule(program, checker, statement, root)
      if (target) dependencies.push({target, kind: 'static-import-or-reexport'})
      const bindings = []
      if (ts.isImportDeclaration(statement)) {
        if (statement.importClause?.name) bindings.push(statement.importClause.name)
        const named = statement.importClause?.namedBindings
        if (named && ts.isNamedImports(named)) bindings.push(...named.elements.map(element => element.name))
        if (named && ts.isNamespaceImport(named)) bindings.push(named.name)
      }
      for (const binding of bindings) {
        const symbol = unalias(checker, checker.getSymbolAtLocation(binding)), id = componentSymbols.get(symbol)
        if (id) imports.set(id, [...imports.get(id) ?? [], {localName: binding.text, module: statement.moduleSpecifier.text, ...reference(root, binding)}])
      }
    }
    const module = checker.getSymbolAtLocation(source)
    for (const symbol of module ? checker.getExportsOfModule(module) : []) {
      const id = componentSymbols.get(unalias(checker, symbol))
      if (id) exports.set(id, [...exports.get(id) ?? [], {file, name: symbol.getName()}])
    }
    walk(source, node => {
      if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        // Browser fixtures enter through HTML route literals and dynamic import(),
        // independently of the test module's own TypeScript imports.
        for (const match of node.text.matchAll(/\/(?:tests\/browser|src)\/[\w./-]+\.[cm]?[jt]sx?/g)) {
          const target = `packages/ui${match[0]}`
          if (knownSources.has(target)) dependencies.push({target, kind: 'browser-path-literal'})
        }
        if (ts.isCallExpression(node.parent) && node.parent.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const target = slash(path.relative(root, path.resolve(path.dirname(source.fileName), node.text)))
          if (knownSources.has(target)) dependencies.push({target, kind: 'dynamic-import-literal'})
        }
      }
      if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return
      const symbol = unalias(checker, checker.getSymbolAtLocation(node.tagName)), id = componentSymbols.get(symbol)
      if (id) usages.set(id, [...usages.get(id) ?? [], {name: node.tagName.getText(), ...reference(root, node)}])
    })
    edges.set(file, [...new Map(dependencies.map(edge => [`${edge.target}:${edge.kind}`, edge])).values()])
  }
  return {imports, usages, exports, edges}
}
function testPaths(edges, source) {
  const reverse = new Map()
  for (const [from, targets] of edges) for (const edge of targets) reverse.set(edge.target, [...reverse.get(edge.target) ?? [], {from, kind: edge.kind}])
  const visited = new Set([source]), queue = [{chain: [source], links: []}], results = []
  while (queue.length) {
    const {chain, links} = queue.shift()
    for (const {from, kind} of (reverse.get(chain[0]) ?? []).sort((a, b) => compareStrings(a.from, b.from) || compareStrings(a.kind, b.kind))) {
      if (visited.has(from)) continue
      visited.add(from)
      const next = [from, ...chain]
      const nextLinks = [{from, to: chain[0], kind}, ...links]
      if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(from)) results.push({file: from, via: next.slice(1), links: nextLinks, kind: 'static-dependency-reachability'})
      queue.push({chain: next, links: nextLinks})
    }
  }
  return results.sort((a, b) => compareStrings(a.file, b.file))
}
export async function buildInventory(root = defaultRoot) {
  const src = path.join(root, 'packages/ui/src'), tests = path.join(root, 'packages/ui/tests')
  const files = sortPaths([...await filesUnder(src, root), ...await filesUnder(tests, root)], root)
  const scriptFiles = files.filter(file => /\.[cm]?[jt]sx?$/.test(file))
  const configPath = path.join(root, 'packages/ui/tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath))
  const program = ts.createProgram(scriptFiles, {...parsed.options, allowJs: true, noEmit: true})
  const checker = program.getTypeChecker()
  const canonicalKey = value => (ts.sys.useCaseSensitiveFileNames ? value : value.toLowerCase())
  const sourceSet = new Set(scriptFiles.map(file => canonicalKey(relativePath(root, file))))
  const sources = program.getSourceFiles()
    .filter(source => sourceSet.has(canonicalKey(relativePath(root, source.fileName))))
    .sort((a, b) => compareStrings(relativePath(root, a.fileName), relativePath(root, b.fileName)))
  const candidates = sources.filter(source => slash(source.fileName).startsWith(slash(src) + '/')).flatMap(source => componentsIn(source))
  const symbols = new Map(candidates.map(component => [checker.getSymbolAtLocation(component.node.name), `${slash(path.relative(root, component.node.getSourceFile().fileName))}#${component.name}`]))
  const graph = evidenceGraph(program, checker, sources, root, symbols)
  const css = await cssIndex(root, files)
  const modules = new Map()
  for (const component of candidates) {
    const source = component.node.getSourceFile(), file = slash(path.relative(root, source.fileName))
    const id = `${file}#${component.name}`
    const body = inspectBody(checker, component, root)
    const classReferences = body.classes.map(item => ({...item, definitions: css.classes.get(item.name) ?? [], resolution: css.classes.has(item.name) ? 'repository-css-selector' : 'unresolved-possibly-utility-or-external'}))
    const tokenNames = ordered([...body.cssVariables.map(item => item.token), ...classReferences.flatMap(item => item.definitions.flatMap(definition => definition.variables))])
    const record = {
      id, name: component.name, declaration: reference(root, component.node), status: 'not-converted',
      parity: {visual: 'unverified', accessibility: 'unverified', interaction: 'unverified'},
      props: properties(checker, component, root), ...body, classes: classReferences,
      tokens: tokenNames.map(name => ({name, definitions: css.tokens.get(name) ?? []})),
      exports: graph.exports.get(id) ?? [], imports: graph.imports.get(id) ?? [], jsxUsages: graph.usages.get(id) ?? [],
      uncertainties: ['Static lexical extraction includes nested callbacks; runtime states and dynamic strings require review.'],
    }
    modules.set(file, [...modules.get(file) ?? [], record])
  }
  const output = new Map()
  const summary = []
  for (const [file, components] of [...modules].sort(([a], [b]) => compareStrings(a, b))) {
    const target = `target/rune-inventory/${file.replace(/^packages\/ui\/src\//, '').replace(/\.[^.]+$/, '').replaceAll('/', '__')}.json`
    const tests = testPaths(graph.edges, file)
    const source = program.getSourceFile(path.join(root, file))
    output.set(target, {source: file, sha256: await digest(path.join(root, file)), moduleLexicalEvidence: inspectBody(checker, {fn: source}, root), testEvidence: tests, components})
    const sheetHash = createHash('sha256').update(JSON.stringify(normalize(output.get(target), root), null, 2) + '\n').digest('hex')
    summary.push({source: file, sheet: target, sheetSha256: sheetHash, components: components.map(({id, name, status}) => ({id, name, status})), testReferenceCount: tests.length})
  }
  const hashes = {}
  const hashFiles = sortPaths([...files, configPath, ...['component-inventory.mjs', 'component-inventory-ast.mjs'].map(file => path.join(root, 'scripts/rune', file))], root)
  for (const file of hashFiles) {
    hashes[relativePath(root, file)] = await digest(file)
  }
  const imports = importEvidence(sources, root)
  output.set('dev-docs/rune-components.generated.json', {
    schemaVersion: 1, generator: 'scripts/rune/component-inventory.mjs', typescriptVersion: ts.version,
    scope: ['packages/ui/src/**/*.{ts,tsx}', 'packages/ui/tests/**/*.{ts,tsx,js,jsx}', 'packages/ui/src/**/*.css'],
    limitations: ['Candidates: named uppercase functions with JSX or Solid Component annotations; wrapper factories and anonymous defaults require manual review.', 'Test evidence records dependency paths from imports/reexports and browser path literals; execution and behavioral coverage require component parity tests.', 'Dynamic classes and translation keys remain expressions; external/utility classes can be unresolved.', 'CSS selector matches are lexical references; cascade, inherited variables, variants and computed styles require rendered verification.', 'Exports, import aliases and reexports use the TypeScript checker. Install lockfile dependencies before generating. External references and unresolved internal paths are recorded independently of installed module availability.', 'moduleLexicalEvidence includes helpers and sibling components; per-component evidence remains lexical, with nested callback bodies.', 'All conversion and parity statuses require independent verification.', 'Full sheets are generated artifacts under target/rune-inventory; the tracked index records their hashes. --check recomputes the index without requiring generated sheets.'],
    unresolvedImports: imports.unresolved, externalImports: imports.external,
    modulesWithoutCandidates: sources.filter(source => source.fileName.endsWith('.tsx') && slash(source.fileName).startsWith(slash(src) + '/') && !modules.has(relativePath(root, source.fileName))).map(source => relativePath(root, source.fileName)),
    inputHashes: hashes, componentCount: candidates.length, modules: summary,
  })
  return new Map([...output].map(([key, value]) => [key, normalize(value, root)]))
}
export async function generate({root = defaultRoot, check = false} = {}) {
  if (!check) {
    const mismatches = await lockfileMismatches(root)
    if (mismatches.length) {
      throw new Error(`node_modules mismatches package-lock.json (${formatMismatches(mismatches)}); run npm ci before running node scripts/rune/component-inventory.mjs`)
    }
  }
  const output = await buildInventory(root)
  for (const [relative, value] of output) {
    if (check && relative.startsWith('target/')) continue
    const target = path.join(root, relative), content = JSON.stringify(value, null, 2) + '\n'
    if (check) {
      let existing
      try { existing = await readFile(target, 'utf8') } catch { throw new Error(`${relative} missing; run node scripts/rune/component-inventory.mjs`) }
      if (existing.replaceAll('\r\n', '\n') !== content) {
        const mismatches = await lockfileMismatches(root)
        const suffix = mismatches.length ? `; node_modules mismatches package-lock.json (${formatMismatches(mismatches)})` : ''
        throw new Error(`${relative} stale${suffix}; run node scripts/rune/component-inventory.mjs`)
      }
    } else { await mkdir(path.dirname(target), {recursive: true}); await writeFile(target, content) }
  }
  // Obsolete sheets must fail checks, so a removed component cannot retain a positive-looking fiche.
  const directory = path.join(root, 'target/rune-inventory')
  const stale = existsSync(directory) ? (await readdir(directory)).filter(file => file.endsWith('.json') && !output.has(`target/rune-inventory/${file}`)).sort(compareStrings) : []
  if (stale.length) throw new Error(`Obsolete component sheets require removal: ${stale.join(', ')}`)
  console.log(`${check ? 'verified' : 'generated'} ${output.size - 1} component modules`)
  return output
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generate({check: process.argv.includes('--check')})
}
