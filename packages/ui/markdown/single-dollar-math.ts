import type { Root } from 'mdast'
import type {} from 'micromark-extension-math'
import type {} from 'remark-parse'
import type { Tokenizer } from 'micromark-util-types'
import type { Processor } from 'unified'
import { SKIP, visit } from 'unist-util-visit'
import { findInlineMath, type InlineMathMatch, type SourceRange } from './inline-math'

const isolated = new Set([
  'code', 'inlineCode', 'link', 'linkReference', 'image', 'imageReference',
  'html', 'definition', 'math', 'inlineMath',
])

/**
 * Use the normal parser to locate code/links (including resolved references),
 * then tokenize validated formulas atomically on a second parse. Source and
 * positions never change: CJK repair and other source-aware plugins still see
 * the authored Markdown. remark-math supplies the mathText mdast handlers.
 */
export function remarkSingleDollarMath(this: Processor) {
  const parser = this.parser
  if (!parser) return
  let matches = new Map<number, InlineMathMatch>()
  const tokenize: Tokenizer = function (effects, ok, nok) {
    const match = matches.get(this.now().offset)
    const now = () => this.now()
    return start

    function start(code: Parameters<typeof effects.consume>[0]) {
      if (!match) return nok(code)
      effects.enter('mathText')
      effects.enter('mathTextSequence')
      effects.consume(code)
      effects.exit('mathTextSequence')
      effects.enter('mathTextData')
      return inside
    }

    function inside(code: Parameters<typeof effects.consume>[0]) {
      // Block syntax (e.g. a GFM table cell) can end this inline scope before
      // a candidate's closing dollar. Let the normal parser handle it.
      if (code === null) return nok(code)
      if (now().offset === match!.end - 1) {
        effects.exit('mathTextData')
        effects.enter('mathTextSequence')
        effects.consume(code)
        effects.exit('mathTextSequence')
        effects.exit('mathText')
        return ok
      }
      effects.consume(code)
      return inside
    }
  }

  const data = this.data()
  const extensions = data.micromarkExtensions ?? (data.micromarkExtensions = [])
  extensions.push({ text: { 36: {
    name: 'validatedInlineMath',
    tokenize,
    // Share remark-math's dollar-run guard. Otherwise our construct makes
    // micromark break inside $$ runs and call mathText at an invalid position.
    previous: (code) => code !== 36,
  } } })
  this.parser = (source, file) => {
    matches = new Map()
    const tree = parser(source, file) as Root
    if (!source.includes('$')) return tree
    const excluded: SourceRange[] = []
    visit(tree, (node) => {
      if (!isolated.has(node.type)) return
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start != null && end != null) excluded.push({ start, end })
      return SKIP
    })
    matches = new Map(findInlineMath(source, excluded).map((match) => [match.start, match]))
    if (matches.size === 0) return tree
    try {
      return parser(source, file)
    } finally {
      matches = new Map()
    }
  }
}
