import { renderToString } from 'katex'

export interface SourceRange {
  start: number
  end: number
}

export interface InlineMathMatch extends SourceRange {
  expression: string
  delimiter: '$' | '$$'
}

const whitespace = /\s/u
const openingPredecessor = /[\\$0-9a-zA-Z]/u
const closingSuccessor = /[\\$0-9a-zA-Z_]/u

function canOpen(source: string, offset: number): boolean {
  const before = source[offset - 1] ?? ''
  const after = source[offset + 1]
  return !openingPredecessor.test(before) && after != null &&
    after !== '$' && !whitespace.test(after)
}

function canClose(source: string, offset: number): boolean {
  const before = source[offset - 1]
  const after = source[offset + 1] ?? ''
  // A backslash before a line ending is a Markdown hard break, not a TeX
  // command. A trailing backslash at EOF is still literal (OL-911).
  const hardBreak = after === '\\' && /[\r\n]/u.test(source[offset + 2] ?? '')
  return before != null && before !== '\\' && before !== '$' &&
    !whitespace.test(before) && (hardBreak || !closingSuccessor.test(after))
}

function validTex(value: string): boolean {
  try {
    renderToString(value, { throwOnError: true, displayMode: false, strict: 'ignore', trust: false })
    return true
  } catch {
    return false
  }
}

function matchDoubleDollar(source: string, start: number, nextRange?: SourceRange): InlineMathMatch | undefined {
  if (source[start - 1] === '$' || source[start + 2] === '$') return
  const end = source.indexOf('$$', start + 2)
  if (end <= start + 2 || source[end + 2] === '$') return
  if (/[\r\n]/u.test(source.slice(start, end))) return
  if (nextRange && nextRange.start < end + 2) return
  const expression = source.slice(start + 2, end)
  if (!validTex(expression)) return
  return { start, end: end + 2, expression, delimiter: '$$' }
}

/**
 * Scan original source, before Markdown interprets TeX punctuation. The caller
 * supplies sorted, non-overlapping ranges identified by its Markdown parser
 * (code, links, HTML, existing math). Crossing one resets the candidate.
 * Only delimiter boundaries and KaTeX decide whether single dollars are math.
 */
export function findInlineMath(
  source: string,
  excluded: readonly SourceRange[],
  doubleDollar = false,
): InlineMathMatch[] {
  const matches: InlineMathMatch[] = []
  let opening: number | null = null
  let rangeIndex = 0

  for (let cursor = 0; cursor < source.length; cursor++) {
    while (excluded[rangeIndex] && excluded[rangeIndex]!.end <= cursor) rangeIndex++
    const range = excluded[rangeIndex]
    if (range && range.start <= cursor) {
      opening = null
      cursor = range.end - 1
      continue
    }
    if (source[cursor] === '\r' || source[cursor] === '\n') {
      opening = null
      continue
    }
    if (source[cursor] !== '$' || source[cursor - 1] === '\\') continue
    if (source[cursor - 1] === '$' || source[cursor + 1] === '$') {
      opening = null
      const match = doubleDollar ? matchDoubleDollar(source, cursor, range) : undefined
      if (match) {
        matches.push(match)
        cursor = match.end - 1
      }
      continue
    }
    if (opening != null && canClose(source, cursor)) {
      const expression = source.slice(opening + 1, cursor)
      if (validTex(expression)) {
        matches.push({ start: opening, end: cursor + 1, expression, delimiter: '$' })
      }
      opening = null
    } else {
      // An intervening dollar resets the candidate. In particular, a dollar
      // before a TeX command remains an opener after a price/env var (OL-911).
      opening = canOpen(source, cursor) ? cursor : null
    }
  }
  return matches
}
