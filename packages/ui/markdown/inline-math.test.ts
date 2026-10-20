// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { findInlineMath } from './inline-math'

describe('findInlineMath', () => {
  it.each(['a $$x\ny$$ b', 'a $$x\r\ny$$ b', 'a $$x\ry$$ b', '$$x$$$', '$$$x$$', '$$$x$$$', '$$$$', '$$x', '$$unclosed { brace$$', String.raw`\$$x$$`])(
    'rejects invalid double-dollar boundaries or TeX: %s',
    (source) => expect(findInlineMath(source, [], true)).toEqual([]),
  )

  it.each(['$$x$$', 'a $$x$$ b', 'q$$x$$', '$$ x_i * y_j $$'])('preserves double-dollar source: %s', (source) => {
    const start = source.indexOf('$$')
    const end = source.lastIndexOf('$$') + 2
    expect(findInlineMath(source, [], true)).toEqual([
      { start, end, expression: source.slice(start + 2, end - 2), delimiter: '$$' },
    ])
    expect(findInlineMath(source, [])).toEqual([])
  })

  it('does not cross an isolated range to find the closing double dollar', () => {
    const source = '$$a `b$$` c'
    expect(findInlineMath(source, [{ start: 4, end: 9 }], true)).toEqual([])
  })

  it('allows isolation immediately after the delimiter and resumes after it', () => {
    const source = '$$x$$`code` $y$'
    expect(findInlineMath(source, [{ start: 5, end: 11 }], true)).toEqual([
      { start: 0, end: 5, expression: 'x', delimiter: '$$' },
      { start: 12, end: 15, expression: 'y', delimiter: '$' },
    ])
  })

  it.each(['a$x$', '$x$a', '$x$_', '$ x$', '$x $', '$x\ny$', String.raw`\$x$`, String.raw`$x$\alpha`])(
    'keeps the shared single-dollar boundary rules: %s',
    (source) => expect(findInlineMath(source, [])).toEqual([]),
  )
})
