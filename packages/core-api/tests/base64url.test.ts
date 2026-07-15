import { describe, expect, it } from 'vitest';

import { decodeBase64url } from '../src/studio/base64url.js';

const textDecoder = new TextDecoder();

describe('decodeBase64url', () => {
  it.each([
    ['', ''],
    ['Zg', 'f'],
    ['Zm8', 'fo'],
    ['Zm9v', 'foo'],
    ['SGVsbG8td29ybGQ_', 'Hello-world?'],
  ])('decodes canonical unpadded input %j', (encoded, expected) => {
    expect(textDecoder.decode(decodeBase64url(encoded))).toBe(expected);
  });

  it('decodes the URL-safe alphabet', () => {
    expect(decodeBase64url('-_8')).toEqual(new Uint8Array([251, 255]));
  });

  it.each(['AA+A', 'AA/A', 'Zm+8', 'Zm/8', 'Zm 8', 'Zm\n8'])(
    'rejects invalid alphabet %j',
    (input) => {
      expect(() => decodeBase64url(input)).toThrow('non-canonical encoding');
    },
  );

  it.each(['=', 'Zg=', 'Zg==', 'Zm9v='])('rejects padding %j', (input) => {
    expect(() => decodeBase64url(input)).toThrow();
  });

  it.each(['A', 'AAAAA'])('rejects impossible encoded length %j', (input) => {
    expect(() => decodeBase64url(input)).toThrow('non-canonical encoding');
  });

  it.each(['Zh', 'Zm9'])('rejects non-canonical trailing bits %j', (input) => {
    expect(() => decodeBase64url(input)).toThrow('non-canonical encoding');
  });
});
