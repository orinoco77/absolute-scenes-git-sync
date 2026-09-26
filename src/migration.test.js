import { jest } from '@jest/globals';

// Helper to convert UTF-8 to base64 (portable version matching Step 4)
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  return btoa(String.fromCharCode(...bytes));
}

jest.unstable_mockModule('./apiClient.js', () => ({
  getRef: jest.fn(),
  getCommit: jest.fn(),
  getTree: jest.fn(),
  getBlob: jest.fn(),
  createBlob: jest.fn(),
  createTree: jest.fn(),
  createCommit: jest.fn(),
  updateRef: jest.fn(),
}));

const { detectRepoLayout, migrateLegacyRepo } = await import('./migration.js');
const apiClient = await import('./apiClient.js');

afterEach(() => jest.restoreAllMocks());

test('detects "empty" when the branch ref does not exist', async () => {
  apiClient.getRef.mockResolvedValue(null);
  const layout = await detectRepoLayout({ repo: 'o/r', token: 't', branch: 'main' });
  expect(layout).toBe('empty');
});

test('detects "new" when book.json exists at the root of the current tree', async () => {
  apiClient.getRef.mockResolvedValue({ sha: 'commit-sha' });
  apiClient.getCommit.mockResolvedValue({ tree: { sha: 'tree-sha' }, parents: [] });
  apiClient.getTree.mockResolvedValue([{ path: 'book.json', type: 'blob', sha: 's1' }]);
  const layout = await detectRepoLayout({ repo: 'o/r', token: 't', branch: 'main' });
  expect(layout).toBe('new');
});

test('detects "legacy" when a single .book file exists at the root and no book.json', async () => {
  apiClient.getRef.mockResolvedValue({ sha: 'commit-sha' });
  apiClient.getCommit.mockResolvedValue({ tree: { sha: 'tree-sha' }, parents: [] });
  apiClient.getTree.mockResolvedValue([{ path: 'My Book.book', type: 'blob', sha: 's1' }]);
  const layout = await detectRepoLayout({ repo: 'o/r', token: 't', branch: 'main' });
  expect(layout).toBe('legacy');
});

test('detects "unrecognized" (not "legacy" or "new") when the repo has commits but no book.json and no root .book file -- e.g. bootstrap-only', async () => {
  // Real scenario that broke a live user: bootstrapEmptyRepo creates one
  // commit containing only _bootstrap.txt, then the first real push is
  // interrupted before book.json ever lands. A later sync attempt must not
  // misclassify this as "legacy" (there is no .book file to migrate --
  // migrateLegacyRepo would crash trying to find one) or as "empty" (the
  // ref does exist). It should be treated the same as a fresh push target,
  // which is what "unrecognized" falls through to in syncRepo -- distinct
  // from "new", which now means specifically "confirmed book.json present".
  apiClient.getRef.mockResolvedValue({ sha: 'bootstrap-commit-sha' });
  apiClient.getCommit.mockResolvedValue({ tree: { sha: 'tree-sha' }, parents: [] });
  apiClient.getTree.mockResolvedValue([{ path: '_bootstrap.txt', type: 'blob', sha: 's1' }]);
  const layout = await detectRepoLayout({ repo: 'o/r', token: 't', branch: 'main' });
  expect(layout).toBe('unrecognized');
});

test('detects "unrecognized" when the repo has commits but neither book.json nor a .book file', async () => {
  apiClient.getRef.mockResolvedValue({ sha: 'commit-sha' });
  apiClient.getCommit.mockResolvedValue({ tree: { sha: 'tree-sha' }, parents: [] });
  apiClient.getTree.mockResolvedValue([{ path: 'README.md', type: 'blob', sha: 's1' }]);
  const layout = await detectRepoLayout({ repo: 'o/r', token: 't', branch: 'main' });
  expect(layout).toBe('unrecognized');
});

test('migrateLegacyRepo decomposes the old blob and commits the new layout on top of history', async () => {
  const oldBookData = { title: 'Old Book', chapters: [{ id: 'ch1', title: 'C1', scenes: [{ id: 'sc1', title: 'S1', content: 'prose', notes: '', created: '', modified: '', assignedAuthor: '' }] }], author: '', frontMatter: [], backMatter: [], parts: [], illustrations: [], characters: [], characterDetectionBlacklist: [], locations: [], backgroundFolders: [], template: {}, collaboration: {}, metadata: {} };

  apiClient.getRef.mockResolvedValue({ sha: 'old-commit-sha' });
  apiClient.getCommit.mockResolvedValue({ tree: { sha: 'old-tree-sha' }, parents: [] });
  apiClient.getTree.mockResolvedValue([{ path: 'My Book.book', type: 'blob', sha: 'blob-sha' }]);
  apiClient.getBlob.mockResolvedValue({ content: utf8ToBase64(JSON.stringify(oldBookData)), encoding: 'base64' });
  apiClient.createBlob.mockResolvedValue({ sha: 'new-blob-sha' });
  apiClient.createTree.mockResolvedValue({ sha: 'new-tree-sha' });
  apiClient.createCommit.mockResolvedValue({ sha: 'migration-commit-sha' });
  apiClient.updateRef.mockResolvedValue({ ok: true });

  const result = await migrateLegacyRepo({
    repo: 'o/r', token: 't', branch: 'main', legacyFilePath: 'My Book.book',
    author: { name: 'Alice', email: 'alice@example.com' },
  });

  expect(result).toEqual({ commitSha: 'migration-commit-sha' });
  // the legacy file must be deleted in the new tree
  const treeCall = apiClient.createTree.mock.calls[0][0];
  expect(treeCall.entries.some(e => e.path === 'My Book.book' && e.sha === null)).toBe(true);
  // book.json and the scene file must be added
  expect(treeCall.entries.some(e => e.path === 'book.json')).toBe(true);
  expect(treeCall.entries.some(e => e.path === 'scenes/sc1.md')).toBe(true);
  // the commit builds on top of the legacy history, single parent
  const commitCall = apiClient.createCommit.mock.calls[0][0];
  expect(commitCall.parents).toEqual(['old-commit-sha']);
});

test('migrateLegacyRepo preserves a pre-chapters legacy book (top-level `scenes`, no `chapters`)', async () => {
  // Real books saved before the app's chapters migration store content
  // under a top-level `scenes` array. migrateLegacyRepo used to hand this
  // straight to projectBook, which only read `chapters` -- silently
  // committing an empty book.json with zero scene files over the real
  // content on GitHub the first time any device synced against it.
  const oldBookData = {
    title: 'Old Book',
    scenes: [{ id: 'sc1', title: 'S1', content: 'Real prose that must survive.', notes: '', created: '', modified: '', assignedAuthor: '' }],
  };

  apiClient.getRef.mockResolvedValue({ sha: 'old-commit-sha' });
  apiClient.getCommit.mockResolvedValue({ tree: { sha: 'old-tree-sha' }, parents: [] });
  apiClient.getTree.mockResolvedValue([{ path: 'My Book.book', type: 'blob', sha: 'blob-sha' }]);
  apiClient.getBlob.mockResolvedValue({ content: utf8ToBase64(JSON.stringify(oldBookData)), encoding: 'base64' });
  apiClient.createBlob.mockResolvedValue({ sha: 'new-blob-sha' });
  apiClient.createTree.mockResolvedValue({ sha: 'new-tree-sha' });
  apiClient.createCommit.mockResolvedValue({ sha: 'migration-commit-sha' });
  apiClient.updateRef.mockResolvedValue({ ok: true });

  await migrateLegacyRepo({
    repo: 'o/r', token: 't', branch: 'main', legacyFilePath: 'My Book.book',
    author: { name: 'Alice', email: 'alice@example.com' },
  });

  const treeCall = apiClient.createTree.mock.calls[0][0];
  expect(treeCall.entries.some(e => e.path === 'scenes/sc1.md')).toBe(true);
  const bookJsonBlobCall = apiClient.createBlob.mock.calls.find(([{ content }]) => content.includes('"chapters"'));
  const bookJson = JSON.parse(bookJsonBlobCall[0].content);
  expect(bookJson.chapters).toHaveLength(1);
  expect(bookJson.chapters[0].scenes).toHaveLength(1);
});
