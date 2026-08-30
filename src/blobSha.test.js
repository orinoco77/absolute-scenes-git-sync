import { computeGitBlobSha } from './blobSha.js';

test('matches real git hash-object output for a simple ascii string', async () => {
  const sha = await computeGitBlobSha('abc', 'utf-8');
  expect(sha).toBe('f2ba8f84ab5c1bce84a7b441cb1959cfc7093b7f');
});

test('matches real git hash-object output for an empty string', async () => {
  const sha = await computeGitBlobSha('', 'utf-8');
  expect(sha).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
});

test('handles multi-byte utf-8 content by hashing byte length, not JS string length', async () => {
  // '🎭' is one JS "character" by naive .length assumptions but 4 bytes in utf-8,
  // and 2 UTF-16 code units -- computeGitBlobSha must hash the real byte length.
  const sha = await computeGitBlobSha('🎭', 'utf-8');
  expect(sha).toBe('5ba04e32df3d2e9fe786c2df0566ebb10d911835');
});

test('base64 encoding hashes the decoded raw bytes, not the base64 text', async () => {
  // base64 of the 3 bytes [0x01, 0x02, 0x03] is "AQID".
  const sha = await computeGitBlobSha('AQID', 'base64');
  expect(sha).toBe('aed2973e4b8a7ff1b30ff5c4751e5a2b38989e74');
});

test('two different content strings never produce the same sha', async () => {
  const a = await computeGitBlobSha('scene one', 'utf-8');
  const b = await computeGitBlobSha('scene two', 'utf-8');
  expect(a).not.toBe(b);
});
