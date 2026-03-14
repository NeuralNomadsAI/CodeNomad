import { createLowlight, common } from "lowlight"

type AstNode = {
  type: string
  value?: string
  children?: AstNode[]
  startIndex?: number
  endIndex?: number
  lineNumber?: number
}

type SyntaxNodeEntry = {
  node: AstNode
  wrapper?: AstNode
}

type SyntaxFileLine = {
  value: string
  lineNumber: number
  valueLength: number
  nodeList: SyntaxNodeEntry[]
}

type LowlightApi = ReturnType<typeof createLowlight>

export function processAST(ast: { children: AstNode[] }) {
  let lineNumber = 1
  const syntaxObj: Record<number, SyntaxFileLine> = {}

  const loopAST = (nodes: AstNode[], wrapper?: AstNode) => {
    nodes.forEach((node) => {
      if (node.type === "text") {
        const textValue = node.value ?? ""
        if (!textValue.includes("\n")) {
          const valueLength = textValue.length
          if (!syntaxObj[lineNumber]) {
            node.startIndex = 0
            node.endIndex = valueLength - 1
            syntaxObj[lineNumber] = {
              value: textValue,
              lineNumber,
              valueLength,
              nodeList: [{ node, wrapper }],
            }
          } else {
            node.startIndex = syntaxObj[lineNumber].valueLength
            node.endIndex = node.startIndex + valueLength - 1
            syntaxObj[lineNumber].value += textValue
            syntaxObj[lineNumber].valueLength += valueLength
            syntaxObj[lineNumber].nodeList.push({ node, wrapper })
          }
          node.lineNumber = lineNumber
          return
        }

        const lines = textValue.split("\n")
        node.children = node.children || []
        for (let index = 0; index < lines.length; index++) {
          const value = index === lines.length - 1 ? lines[index] : `${lines[index]}\n`
          const currentLineNumber = index === 0 ? lineNumber : ++lineNumber
          const valueLength = value.length
          const childNode: AstNode = {
            type: "text",
            value,
            startIndex: Infinity,
            endIndex: Infinity,
            lineNumber: currentLineNumber,
          }

          if (!syntaxObj[currentLineNumber]) {
            childNode.startIndex = 0
            childNode.endIndex = valueLength - 1
            syntaxObj[currentLineNumber] = {
              value,
              lineNumber: currentLineNumber,
              valueLength,
              nodeList: [{ node: childNode, wrapper }],
            }
          } else {
            childNode.startIndex = syntaxObj[currentLineNumber].valueLength
            childNode.endIndex = childNode.startIndex + valueLength - 1
            syntaxObj[currentLineNumber].value += value
            syntaxObj[currentLineNumber].valueLength += valueLength
            syntaxObj[currentLineNumber].nodeList.push({ node: childNode, wrapper })
          }

          node.children.push(childNode)
        }

        node.lineNumber = lineNumber
        return
      }

      if (node.children) {
        loopAST(node.children, node)
        node.lineNumber = lineNumber
      }
    })
  }

  loopAST(ast.children)
  return { syntaxFileObject: syntaxObj, syntaxFileLineNumber: lineNumber }
}

export function _getAST() {
  return {}
}

const lowlight = createLowlight(common)

lowlight.register("vue", function hljsDefineVue(hljs: any) {
  return {
    subLanguage: "xml",
    contains: [
      hljs.COMMENT("<!--", "-->", { relevance: 10 }),
      {
        begin: /^(\s*)(<script>)/gm,
        end: /^(\s*)(<\/script>)/gm,
        subLanguage: "javascript",
        excludeBegin: true,
        excludeEnd: true,
      },
      {
        begin: /^(?:\s*)(?:<script\s+lang=(["'])ts\1>)/gm,
        end: /^(\s*)(<\/script>)/gm,
        subLanguage: "typescript",
        excludeBegin: true,
        excludeEnd: true,
      },
      {
        begin: /^(\s*)(<style(\s+scoped)?>)/gm,
        end: /^(\s*)(<\/style>)/gm,
        subLanguage: "css",
        excludeBegin: true,
        excludeEnd: true,
      },
      {
        begin: /^(?:\s*)(?:<style(?:\s+scoped)?\s+lang=(["'])(?:s[ca]ss)\1(?:\s+scoped)?>)/gm,
        end: /^(\s*)(<\/style>)/gm,
        subLanguage: "scss",
        excludeBegin: true,
        excludeEnd: true,
      },
      {
        begin: /^(?:\s*)(?:<style(?:\s+scoped)?\s+lang=(["'])stylus\1(?:\s+scoped)?>)/gm,
        end: /^(\s*)(<\/style>)/gm,
        subLanguage: "stylus",
        excludeBegin: true,
        excludeEnd: true,
      },
    ],
  }
})

let maxLineToIgnoreSyntax = 2000
const ignoreSyntaxHighlightList: (string | RegExp)[] = []

export const highlighter = {
  name: "lowlight",
  get maxLineToIgnoreSyntax() {
    return maxLineToIgnoreSyntax
  },
  setMaxLineToIgnoreSyntax(value: number) {
    maxLineToIgnoreSyntax = value
  },
  get ignoreSyntaxHighlightList() {
    return ignoreSyntaxHighlightList
  },
  setIgnoreSyntaxHighlightList(values: (string | RegExp)[]) {
    ignoreSyntaxHighlightList.length = 0
    ignoreSyntaxHighlightList.push(...values)
  },
  getAST(raw: string, fileName?: string, lang?: string) {
    const language = String(lang || "plaintext")
    if (
      fileName &&
      ignoreSyntaxHighlightList.some((item) => (item instanceof RegExp ? item.test(fileName) : fileName === item))
    ) {
      return undefined
    }

    if (lowlight.registered(language)) {
      return lowlight.highlight(language, raw)
    }

    return lowlight.highlightAuto(raw)
  },
  processAST(ast: { children: AstNode[] }) {
    return processAST(ast)
  },
  hasRegisteredCurrentLang(lang: string) {
    return lowlight.registered(lang)
  },
  getHighlighterEngine(): LowlightApi {
    return lowlight
  },
  type: "class" as const,
}

export const versions = "local-common"
