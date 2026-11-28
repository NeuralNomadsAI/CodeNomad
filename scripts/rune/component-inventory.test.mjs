import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises'
import path from 'node:path'
import {buildInventory, canonicalPath, defaultRoot, generate, lockfileMismatches, sortPaths} from './component-inventory.mjs'

async function fixture(run) {
  // All generated fixture files stay inside the owned worktree.
  const root = await mkdtemp(path.join(defaultRoot, 'scripts/rune/.inventory-test-'))
  const put = async (file, value) => { const target = path.join(root, file); await mkdir(path.dirname(target), {recursive: true}); await writeFile(target, value) }
  try {
    await put('packages/ui/tsconfig.json', JSON.stringify({compilerOptions: {strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', jsx: 'preserve', paths: {'@/*': ['./src/*']}}}))
    await put('packages/ui/src/solid.d.ts', `declare namespace JSX { interface IntrinsicElements { button: any; div: any } }
declare module 'solid-js' { export type Component<P = {}> = (props: P) => any; export function createSignal<T>(initial: T): [() => T, (value: T) => void] }
`)
    await put('packages/ui/src/components/control.tsx', `import {createSignal as signal, type Component} from 'solid-js'
interface Base { title: string }
interface Props extends Base { disabled?: boolean; onClick: (value: string) => void }
const t = (key: string) => key
export const Control: Component<Props> = props => {
 const [open, setOpen] = signal(false)
 return <button class="shared px-2" classList={{'is-open': open()}} title={t('control.title')} style={{color: 'var(--foreground)'}} onClick={() => props.onClick(props.title)}>{t(open() ? 'open' : 'closed')}</button>
}
export default Control
`)
    await put('packages/ui/src/components/barrel.ts', "export {default as Renamed} from './control'\n")
    await put('packages/ui/src/components/consumer.tsx', `import {Renamed as Alias} from '@/components/barrel'
import * as Controls from './barrel'
export function Consumer() { return <div><Alias title="one" onClick={() => {}}/><Controls.Renamed title="two" onClick={() => {}}/></div> }
`)
    await put('packages/ui/src/components/anonymous.tsx', 'export default () => <div/>')
    await put('packages/ui/src/styles/tokens.css', ':root { --foreground: #fff; --hover: var(--foreground); }\n.shared:hover { color: var(--hover); }\n.is-open { display: block }\n')
    await put('packages/ui/tests/browser/fixture.tsx', "import {Consumer} from '../../src/components/consumer'\nexport const render = () => <Consumer/>\n")
    await put('packages/ui/tests/browser/control.test.ts', "import {render} from './fixture'\nrender()\n")
    await put('packages/ui/tests/browser/route.test.ts', `const html = '<script src="/tests/browser/fixture.tsx"></script>'\n`)
    for (const file of ['component-inventory.mjs', 'component-inventory-ast.mjs']) await put(`scripts/rune/${file}`, await readFile(path.join(defaultRoot, 'scripts/rune', file)))
    await run(root, put)
  } finally { await rm(root, {recursive: true, force: true}) }
}
test('copied Monaco distribution cannot change Source hashes or CSS evidence', async () => fixture(async (root, put) => {
  await put('packages/ui/src/renderer/public/monaco.worker.js', 'self.onmessage = () => {}')
  const before = await buildInventory(root)
  await put('packages/ui/src/renderer/public/monaco/vs/editor/editor.main.css', '.shared { color: red; }')
  await put('packages/ui/src/renderer/public/monaco/vs/editor/editor.main.js', 'self.vendor = true')
  const after = await buildInventory(root)
  assert.deepEqual(after, before)
  assert.ok(after.get('dev-docs/rune-components.generated.json').inputHashes['packages/ui/src/renderer/public/monaco.worker.js'])
}))

test('AST resolves typed inherited props, aliased state, CSS references, dynamic keys and reexported usages', async () => fixture(async root => {
  const output = await buildInventory(root)
  const sheet = output.get('target/rune-inventory/components__control.json')
  const control = sheet.components[0]
  assert.equal(control.status, 'not-converted')
  assert.deepEqual(control.parity, {visual: 'unverified', accessibility: 'unverified', interaction: 'unverified'})
  assert.deepEqual(control.props.fields.map(({name, optional}) => [name, optional]), [['disabled', true], ['onClick', false], ['title', false]])
  assert.equal(control.props.fields.find(field => field.name === 'title').declarations[0].line, 2)
  assert.equal(control.states[0].factory, 'createSignal')
  assert.equal(control.states[0].binding, '[open, setOpen]')
  assert.deepEqual(control.translations.map(item => item.key), ['control.title', null])
  assert.ok(control.translations[1].expression.includes('open()'))
  assert.ok(control.classes.find(item => item.name === 'shared').definitions[0].selector.includes(':hover'))
  assert.equal(control.classes.find(item => item.name === 'px-2').resolution, 'unresolved-possibly-utility-or-external')
  assert.ok(control.tokens.some(item => item.name === '--foreground' && item.definitions[0].value === '#fff'))
  assert.ok(control.tokens.some(item => item.name === '--hover'))
  assert.ok(control.exports.some(item => item.name === 'Renamed'))
  assert.ok(control.exports.some(item => item.name === 'default'))
  assert.ok(control.imports.some(item => item.localName === 'Alias'))
  assert.deepEqual(control.jsxUsages.map(item => item.name), ['Alias', 'Controls.Renamed'])
  assert.deepEqual(sheet.testEvidence[0].via, ['packages/ui/tests/browser/fixture.tsx', 'packages/ui/src/components/consumer.tsx', 'packages/ui/src/components/barrel.ts', 'packages/ui/src/components/control.tsx'])
  assert.equal(sheet.testEvidence[0].kind, 'static-dependency-reachability')
  assert.ok(sheet.testEvidence.find(item => item.file.endsWith('/route.test.ts')).links.some(link => link.kind === 'browser-path-literal'))
  assert.ok(output.get('dev-docs/rune-components.generated.json').modulesWithoutCandidates.includes('packages/ui/src/components/anonymous.tsx'))
}))
test('generation is deterministic, checks changed inputs, and rejects obsolete component sheets', async () => fixture(async (root, put) => {
  const first = await generate({root})
  const second = await buildInventory(root)
  assert.deepEqual(first, second)
  assert.ok(!JSON.stringify([...first]).includes(root.replaceAll('\\', '/')))
  const index = first.get('dev-docs/rune-components.generated.json')
  assert.ok(index.externalImports.some(item => item.specifier === 'solid-js' && item.resolution === 'external-dependency-requires-installed-contract'))
  for (const file of Object.keys(index.inputHashes).filter(file => /\.(?:[cm]?[jt]sx?|css)$/.test(file))) {
    const text = await readFile(path.join(root, file), 'utf8')
    await put(file, text.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'))
  }
  assert.deepEqual(first, await buildInventory(root), 'CRLF and LF inputs produce identical inventory and hashes')
  await put('dev-docs/rune-components.generated.json', JSON.stringify(first.get('dev-docs/rune-components.generated.json'), null, 2).replaceAll('\n', '\r\n') + '\r\n')
  await generate({root, check: true})
  await put('packages/ui/src/styles/tokens.css', ':root { --foreground: #000 } .shared { color: var(--foreground) }')
  await assert.rejects(generate({root, check: true}), /stale/)
  await generate({root})
  await put('target/rune-inventory/obsolete.json', '{}')
  await assert.rejects(generate({root, check: true}), /Obsolete component sheets/)
}))
test('real Solid dismissal component has source props, translated accessible label and repository style references', async () => {
  const output = await buildInventory()
  const serialized = JSON.stringify([...output])
  assert.ok(!serialized.includes(defaultRoot.replaceAll('\\', '/')), 'TypeScript import types use repository-relative paths')
  assert.ok(!serialized.includes(defaultRoot.replaceAll('\\', '\\\\')), 'No absolute Windows worktree roots')
  const button = output.get('target/rune-inventory/components__window-close-button.json').components[0]
  assert.equal(button.name, 'WindowCloseButton')
  assert.ok(button.props.fields.some(field => field.name === 'onClose' && field.type.includes('=> void')))
  assert.ok(button.translations.some(item => item.key === 'toastHistory.close'))
  assert.ok(button.classes.some(item => item.name === 'window-icon-button' && item.definitions.some(definition => definition.file.endsWith('/window.css'))))
  assert.ok(button.exports.some(item => item.name === 'default'))
  const alert = output.get('target/rune-inventory/components__alert-dialog.json')
  assert.ok(alert.testEvidence.some(item => item.file.endsWith('/alert-dialog.test.ts') && item.links.some(link => link.kind === 'browser-path-literal')))
})

test('cross-OS path sorting is identical for Windows and POSIX roots and produces code-point order in inventory', async () => {
  const relative = [
    'packages/ui/src/panel/a.css',
    'packages/ui/src/panelA.css',
    'packages/ui/src/panel2.css',
    'packages/ui/src/panel-b.css',
    'packages/ui/src/panel.css',
    'packages/ui/src/panel_c.css',
    'packages/ui/src/panela.css',
  ]
  const winRoot = 'D:\\CodeNomad'
  const posixRoot = '/home/runner/work/CodeNomad/CodeNomad'
  const winPaths = relative.map(item => `${winRoot}\\${item.replaceAll('/', '\\')}`)
  const posixPaths = relative.map(item => `${posixRoot}/${item}`)
  // Sanity check: raw OS-native .sort() diverges because '\\' (92) > '2'/'A' whereas '/' (47) < '2'/'A'.
  const naiveWin = [...winPaths].sort().map(item => canonicalPath(item, winRoot))
  const naivePosix = [...posixPaths].sort().map(item => canonicalPath(item, posixRoot))
  assert.notDeepEqual(naiveWin, naivePosix)

  const sortedWin = sortPaths(winPaths, winRoot).map(item => canonicalPath(item, winRoot))
  const sortedPosix = sortPaths(posixPaths, posixRoot).map(item => canonicalPath(item, posixRoot))
  const expected = [
    'packages/ui/src/panel-b.css',
    'packages/ui/src/panel.css',
    'packages/ui/src/panel/a.css',
    'packages/ui/src/panel2.css',
    'packages/ui/src/panelA.css',
    'packages/ui/src/panel_c.css',
    'packages/ui/src/panela.css',
  ]
  assert.deepEqual(sortedWin, expected)
  assert.deepEqual(sortedPosix, expected)

  await fixture(async (root, put) => {
    await put('packages/ui/src/styles/panel/a.css', '.shared { color: var(--panel-a); }\n:root { --panel-a: #111; }\n')
    await put('packages/ui/src/styles/panel2.css', '.shared { color: var(--panel-2); }\n:root { --panel-2: #222; }\n')
    await put('packages/ui/src/styles/panelA.css', '.shared { color: var(--panel-A); }\n:root { --panel-A: #333; }\n')
    await put('packages/ui/src/styles/panel-b.css', '.shared { color: var(--panel-b); }\n:root { --panel-b: #444; }\n')
    await put('packages/ui/src/components/panel/Item.tsx', `import {type Component} from 'solid-js'\nexport const PanelItem: Component = () => <div class="shared"/>\n`)
    await put('packages/ui/src/components/panelA.tsx', `import {type Component} from 'solid-js'\nexport const PanelA: Component = () => <div class="shared"/>\n`)
    const output = await buildInventory(root)
    const index = output.get('dev-docs/rune-components.generated.json')
    const panelHashes = Object.keys(index.inputHashes).filter(key => key.startsWith('packages/ui/src/styles/panel'))
    assert.deepEqual(panelHashes, [
      'packages/ui/src/styles/panel-b.css',
      'packages/ui/src/styles/panel/a.css',
      'packages/ui/src/styles/panel2.css',
      'packages/ui/src/styles/panelA.css',
    ])
    const controlSheet = output.get('target/rune-inventory/components__control.json')
    const sharedFiles = controlSheet.components[0].classes
      .find(item => item.name === 'shared')
      .definitions.map(def => def.file)
      .filter(file => file.startsWith('packages/ui/src/styles/panel'))
    assert.deepEqual(sharedFiles, [
      'packages/ui/src/styles/panel-b.css',
      'packages/ui/src/styles/panel/a.css',
      'packages/ui/src/styles/panel2.css',
      'packages/ui/src/styles/panelA.css',
    ])
    const panelModules = index.modules.map(item => item.source).filter(source => source.startsWith('packages/ui/src/components/panel'))
    assert.deepEqual(panelModules, [
      'packages/ui/src/components/panel/Item.tsx',
      'packages/ui/src/components/panelA.tsx',
    ])
  })
})

test('generate refuses mismatched lockfile versions and reports drift on stale checks', async () => fixture(async (root, put) => {
  await put('package-lock.json', JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': {name: 'fixture'},
      'node_modules/@opencode/client': {version: '2.4.2'},
      'node_modules/@codenomad/ui': {resolved: 'packages/ui', link: true},
      'node_modules/@esbuild/linux-x64': {version: '0.25.0', optional: true},
    },
  }))
  await put('node_modules/@opencode/client/package.json', JSON.stringify({name: '@opencode/client', version: '2.4.1'}))
  assert.deepEqual(await lockfileMismatches(root), [{pkg: '@opencode/client', installed: '2.4.1', expected: '2.4.2'}])
  await assert.rejects(generate({root}), /@opencode\/client: installed 2\.4\.1, lockfile 2\.4\.2/)

  await put('dev-docs/rune-components.generated.json', '{}\n')
  await assert.rejects(generate({root, check: true}), /stale; node_modules mismatches package-lock\.json \(@opencode\/client: installed 2\.4\.1, lockfile 2\.4\.2\)/)

  await put('node_modules/@opencode/client/package.json', JSON.stringify({name: '@opencode/client', version: '2.4.2'}))
  assert.deepEqual(await lockfileMismatches(root), [])
  await generate({root})
  await generate({root, check: true})
}))
