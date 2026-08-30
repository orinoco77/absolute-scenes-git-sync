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
