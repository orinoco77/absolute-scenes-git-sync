function bytesToHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

function concatBytes(...arrays) {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

export async function computeGitBlobSha(content, encoding = 'utf-8') {
  const contentBytes =
    encoding === 'base64' ? base64ToBytes(content) : new TextEncoder().encode(content);
  const header = new TextEncoder().encode(`blob ${contentBytes.length}\0`);
  const full = concatBytes(header, contentBytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-1', full);
  return bytesToHex(new Uint8Array(digest));
}
