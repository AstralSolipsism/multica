import { renderToString } from 'katex'
import type { PhrasingContent, Root, Text } from 'mdast'
import { decodeString } from 'micromark-util-decode-string'
import { SKIP, visit } from 'unist-util-visit'

const whitespace = /\s/u
const openingPredecessor = /[\\$0-9a-zA-Z]/u
const closingSuccessor = /[$0-9a-zA-Z_]/u

function canOpen(source: string, offset: number): boolean {
  const before = source[offset - 1] ?? ''
  const after = source[offset + 1]
  return !openingPredecessor.test(before) && after != null &&
    after !== '$' && !whitespace.test(after)
}

function canClose(source: string, offset: number): boolean {
  const before = source[offset - 1]
  const after = source[offset + 1] ?? ''
  return before != null && before !== '\\' && before !== '$' &&
    !whitespace.test(before) && !closingSuccessor.test(after)
}

function validTex(value: string): boolean {
  try {
    renderToString(value, { throwOnError: true, displayMode: false, strict: 'ignore', trust: false })
    return true
  } catch {
    return false
  }
}

function splitText(node: Text, source: string): PhrasingContent[] | null {
  if (!node.value.includes('$')) return null
  const position = node.position
  const start = position?.start.offset
  const end = position?.end.offset
  if (position == null || start == null || end == null) return null

  // Source retains TeX escapes and distinguishes literal dollars from \$ or
  // &#36;. Work one line at a time so soft breaks cannot close inline math.
  const rawLines = source.slice(start, end).split(/(\r\n|\r|\n)/u)
  const valueLines = node.value.split(/(\r\n|\r|\n)/u)
  if (rawLines.length !== valueLines.length) return null

  const replacement: PhrasingContent[] = []
  let sourceOffset = start
  let valueOffset = 0
  let consumed = 0
  let consumedPoint = position.start

  for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex++) {
    const raw = rawLines[lineIndex]!
    const value = valueLines[lineIndex]!
    // Markdown drops literal spaces/tabs before soft breaks from text values.
    // Normalize only for alignment, before decoding references: &#32; remains
    // authored text, and raw source offsets and TeX must stay unchanged.
    const decoded = decodeString(
      lineIndex < rawLines.length - 1 ? raw.replace(/[ \t]+$/u, '') : raw,
    )
    // Continuation lines in lists/quotes include container prefixes in the
    // source range, but not in the text value. Exclude those prefixes. Refuse
    // nodes already rewritten by another plugin when their source won't align.
    if (lineIndex % 2 === 0 && decoded.endsWith(value)) {
      let opening: number | null = null
      let rawCursor = 0
      let valueCursor = valueOffset - (decoded.length - value.length)

      for (let cursor = 0; cursor < raw.length; cursor++) {
        if (raw[cursor] !== '$') continue
        const offset = sourceOffset + cursor
        if (source[offset - 1] === '\\') continue
        if (source[offset - 1] === '$' || source[offset + 1] === '$') {
          opening = null
          continue
        }

        if (opening != null && canClose(source, offset)) {
          const expression = raw.slice(opening + 1, cursor)
          if (validTex(expression)) {
            const from = valueCursor + decodeString(raw.slice(rawCursor, opening)).length
            const to = from + decodeString(raw.slice(opening, cursor + 1)).length
            if (from >= valueOffset) {
              const line = position.start.line + lineIndex / 2
              const column = lineIndex === 0 ? position.start.column : 1
              const openingPoint = { line, column: column + opening, offset: sourceOffset + opening }
              const closingPoint = { line, column: column + cursor + 1, offset: offset + 1 }
              // Downstream source-aware transforms (e.g. CJK emphasis repair)
              // must still be able to inspect the untouched text fragments.
              if (from > consumed) {
                replacement.push({
                  type: 'text',
                  value: node.value.slice(consumed, from),
                  position: { start: consumedPoint, end: openingPoint },
                })
              }
              replacement.push({
                type: 'inlineMath',
                value: expression,
                position: { start: openingPoint, end: closingPoint },
                data: {
                  hName: 'code',
                  hProperties: { className: ['language-math', 'math-inline'] },
                  hChildren: [{ type: 'text', value: expression }],
                },
              })
              consumed = to
              consumedPoint = closingPoint
              rawCursor = cursor + 1
              valueCursor = to
            }
          }
          opening = null
        } else {
          // An intervening unescaped dollar starts a new candidate or ends
          // this one. Never swallow a price followed by a separate formula.
          opening = canOpen(source, offset) ? cursor : null
        }
      }
    }
    sourceOffset += raw.length
    valueOffset += value.length
  }

  if (replacement.length === 0) return null
  if (consumed < node.value.length) {
    replacement.push({
      type: 'text',
      value: node.value.slice(consumed),
      position: { start: consumedPoint, end: position.end },
    })
  }
  return replacement
}

/**
 * Run alongside remark-math with singleDollarTextMath disabled, before
 * remark-breaks. Only literal text nodes can gain single-dollar math; links,
 * code, HTML and existing double-dollar math keep their Markdown semantics.
 * Delimiter boundaries choose candidates; KaTeX alone validates their content.
 */
export function remarkSingleDollarMath() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value ?? '')
    visit(tree, (node, index, parent) => {
      if (node.type === 'link' || node.type === 'linkReference') return SKIP
      if (node.type !== 'text' || index == null || parent == null) return
      const replacement = splitText(node, source)
      if (!replacement) return
      parent.children.splice(index, 1, ...replacement)
      return index + replacement.length
    })
  }
}
