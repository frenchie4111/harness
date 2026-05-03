import { describe, it, expect } from 'vitest'
import { tolerantJsonParse } from './tolerant-json-parse'

describe('tolerantJsonParse', () => {
  it('parses complete JSON objects strictly', () => {
    expect(tolerantJsonParse('{"a":1}')).toEqual({ a: 1 })
    expect(tolerantJsonParse('{"a":"b","c":[1,2,3]}')).toEqual({
      a: 'b',
      c: [1, 2, 3]
    })
  })

  it('repairs an unclosed object', () => {
    expect(tolerantJsonParse('{"a":1')).toEqual({ a: 1 })
  })

  it('repairs an unclosed string + unclosed object', () => {
    expect(tolerantJsonParse('{"a":"hel')).toEqual({ a: 'hel' })
  })

  it('repairs a partial value mid-string with prior complete keys', () => {
    expect(
      tolerantJsonParse('{"file_path":"/abs/path/foo.ts","old_string":"const ')
    ).toEqual({ file_path: '/abs/path/foo.ts', old_string: 'const ' })
  })

  it('drops a trailing comma after a complete pair', () => {
    expect(tolerantJsonParse('{"a":"b",')).toEqual({ a: 'b' })
  })

  it('drops a trailing partial key without a colon', () => {
    expect(tolerantJsonParse('{"a":"b","c"')).toEqual({ a: 'b' })
  })

  it('drops a trailing key with colon but no value', () => {
    expect(tolerantJsonParse('{"a":"b","c":')).toEqual({ a: 'b' })
  })

  it('drops a trailing partial primitive', () => {
    expect(tolerantJsonParse('{"a":"b","c":1.')).toEqual({ a: 'b' })
    expect(tolerantJsonParse('{"a":"b","c":tru')).toEqual({ a: 'b' })
  })

  it('returns null for non-JSON garbage', () => {
    expect(tolerantJsonParse('invalid')).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(tolerantJsonParse('')).toBeNull()
  })

  it('returns null when no usable prefix can be recovered', () => {
    // Just an opening brace + a key with colon — no complete pair anywhere
    expect(tolerantJsonParse('{"a":')).toBeNull()
  })

  it('handles escape sequences inside strings', () => {
    expect(tolerantJsonParse('{"a":"line1\\nline2"')).toEqual({
      a: 'line1\nline2'
    })
    expect(tolerantJsonParse('{"a":"escaped \\" quote"')).toEqual({
      a: 'escaped " quote'
    })
  })

  it('handles a trailing dangling backslash inside a string', () => {
    // `\` with nothing following is an incomplete escape — drop it before
    // closing the string so the parse doesn't choke.
    const out = tolerantJsonParse('{"a":"foo\\')
    expect(out).toEqual({ a: 'foo' })
  })

  it('handles nested objects and arrays', () => {
    expect(tolerantJsonParse('{"a":{"b":[1,2,')).toEqual({ a: { b: [1, 2] } })
  })

  it('returns null for non-object JSON (we only accept objects)', () => {
    expect(tolerantJsonParse('[1,2,3]')).toBeNull()
    expect(tolerantJsonParse('"just a string"')).toBeNull()
    expect(tolerantJsonParse('42')).toBeNull()
  })
})
