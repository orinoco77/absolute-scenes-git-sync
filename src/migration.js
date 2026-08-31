import { getRef, getCommit, getTree, getBlob, createBlob, createTree, createCommit, updateRef } from './apiClient.js';
import { projectBook } from './project.js';

function base64ToUtf8(base64) {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export async function detectRepoLayout({ repo, token, branch }) {
  const ref = await getRef({ repo, token, branch });
  if (!ref) return 'empty';
  const commit = await getCommit({ repo, token, sha: ref.sha });
  const tree = await getTree({ repo, token, sha: commit.tree.sha });
  const rootEntries = tree.filter(e => !e.path.includes('/'));
  if (rootEntries.some(e => e.path === 'book.json')) return 'new';
  // Only classify as "legacy" when there's an actual single-file .book
  // blob to migrate. A repo with commits but neither book.json nor a
  // legacy .book file (e.g. one that only ever got as far as
  // bootstrapEmptyRepo's placeholder commit before being interrupted) has
  // nothing to migrate -- treat it the same as a fresh push target rather
  // than crashing migrateLegacyRepo's search for a file that isn't there.
  if (rootEntries.some(e => e.path.endsWith('.book'))) return 'legacy';
  return 'new';
}

export async function migrateLegacyRepo({ repo, token, branch, legacyFilePath, author }) {
  const ref = await getRef({ repo, token, branch });
  const commit = await getCommit({ repo, token, sha: ref.sha });
  const tree = await getTree({ repo, token, sha: commit.tree.sha });
  const legacyEntry = tree.find(e => e.path === legacyFilePath);

  const blob = await getBlob({ repo, token, sha: legacyEntry.sha });
  const rawJson = base64ToUtf8(blob.content);
  const bookData = JSON.parse(rawJson);

  const files = projectBook(bookData);
  const entries = [{ path: legacyFilePath, mode: '100644', type: 'blob', sha: null }];
  for (const [path, { content, encoding }] of files) {
    const { sha } = await createBlob({ repo, token, content, encoding });
    entries.push({ path, mode: '100644', type: 'blob', sha });
  }

  const newTree = await createTree({ repo, token, baseTree: commit.tree.sha, entries });
  const newCommit = await createCommit({
    repo, token,
    message: 'Migrate to decomposed git-native layout',
    tree: newTree.sha,
    parents: [ref.sha],
    author,
  });
  await updateRef({ repo, token, branch, sha: newCommit.sha, force: false });
  return { commitSha: newCommit.sha };
}
