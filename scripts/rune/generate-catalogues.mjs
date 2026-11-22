// Read only the locale modules imported by each canonical index; never execute feature code.
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'
import {root,generated,sources} from './generate-common.mjs'

const i18n=path.join(root,'packages/ui/src/lib/i18n'),catalogues={},files=[path.join(i18n,'index.tsx'),path.join(i18n,'messages/merge.ts')]
const entry=ts.createSourceFile(files[0],await readFile(files[0],'utf8'),ts.ScriptTarget.Latest,true)
let locales
for(const statement of entry.statements)if(ts.isVariableStatement(statement))for(const declaration of statement.declarationList.declarations){
  if(declaration.name.getText(entry)!=='SUPPORTED_LOCALES')continue
  let value=declaration.initializer;while(ts.isAsExpression(value))value=value.expression
  assert(ts.isArrayLiteralExpression(value),'SUPPORTED_LOCALES must remain an explicit catalogue')
  locales=value.elements.map(v=>{assert(ts.isStringLiteral(v));return v.text})
}
assert(locales?.length===10,'The shared catalogue must provide the ten supported locales')
const rtl=/const RTL_LOCALES = new Set<Locale>\(\[([^\]]+)\]\)/.exec(await readFile(files[0],'utf8'))?.[1]
assert(rtl,'RTL_LOCALES must remain explicit')
for(const locale of locales){
  const folder=path.join(i18n,'messages',locale),index=path.join(folder,'index.ts'),text=await readFile(index,'utf8')
  files.push(index)
  const ast=ts.createSourceFile(index,text,ts.ScriptTarget.Latest,true),imports=new Map(),parts=new Map(),messages={}
  let merge
  for(const statement of ast.statements){
    if(ts.isImportDeclaration(statement)&&statement.importClause?.namedBindings&&ts.isNamedImports(statement.importClause.namedBindings)){
      for(const specifier of statement.importClause.namedBindings.elements)imports.set(specifier.name.text,statement.moduleSpecifier.text)
    }
    if(ts.isVariableStatement(statement))for(const declaration of statement.declarationList.declarations){
      if(ts.isCallExpression(declaration.initializer)&&declaration.initializer.expression.getText(ast)==='mergeMessageParts')merge=declaration.initializer.arguments.map(n=>n.getText(ast))
    }
  }
  assert(merge?.length,`${locale}: missing canonical mergeMessageParts`)
  for(const binding of merge){
    const module=imports.get(binding);assert(module?.startsWith('./'),`${locale}: catalogue import must be local`)
    const file=path.join(folder,module+'.ts');files.push(file)
    const source=ts.createSourceFile(file,await readFile(file,'utf8'),ts.ScriptTarget.Latest,true)
    for(const statement of source.statements)if(ts.isVariableStatement(statement))for(const declaration of statement.declarationList.declarations){
      if(declaration.name.getText(source)!==binding)continue
      let value=declaration.initializer;while(ts.isAsExpression(value))value=value.expression
      assert(ts.isObjectLiteralExpression(value),`${file}: messages must remain literal data`)
      parts.set(binding,value.properties.map(property=>{
        assert(ts.isPropertyAssignment(property)&&ts.isStringLiteral(property.name)&&ts.isStringLiteral(property.initializer),`${file}: unsupported message expression`)
        return [property.name.text,property.initializer.text]
      }))
    }
    assert(parts.has(binding),`${file}: exported catalogue ${binding} missing`)
    for(const [key,value] of parts.get(binding)){assert(!(key in messages),`${locale}: duplicate key ${key}`);messages[key]=value}
  }
  catalogues[locale]={direction:rtl.includes(`"${locale}"`)?'rtl':'ltr',messages}
}
for(const locale of locales)await generated(`assets/catalogues/${locale}.json`,catalogues[locale].messages)
await generated('assets/catalogues.json',{locales,directions:Object.fromEntries(locales.map(locale=>[locale,catalogues[locale].direction])),sources:await sources(files)})
await generated('src/generated_catalogues.rs',`// Generated from the shared UI catalogues by scripts/rune/generate-catalogues.mjs.\n`+
  `#[rustfmt::skip]\npub const SUPPORTED_LOCALES: &[&str] = &[\n    ${locales.map(v=>JSON.stringify(v)).join(', ')},\n];\n`+
  `#[rustfmt::skip]\npub(super) const SOURCES: &[(&str, &str, bool)] = &[\n`+
  locales.map(locale=>{
    const fields=[JSON.stringify(locale), `include_str!("../assets/catalogues/${locale}.json")`, String(catalogues[locale].direction==='rtl')]
    const inline=`    (${fields.join(', ')}),`
    return inline.length<=100?inline:`    (\n${fields.map(value=>`        ${value},`).join('\n')}\n    ),`
  }).join('\n')+`\n];\n`)
