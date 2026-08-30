import { jest } from '@jest/globals';

function makeBook(title = 'Book') {
  return {
    title, author: 'A', frontMatter: [], backMatter: [], parts: [],
    chapters: [{ id: 'ch1', title: 'C1', scenes: [{ id: 'sc1', title: 'S1', content: 'prose', notes: '', created: '', modified: '', assignedAuthor: '' }] }],
    illustrations: [], characters: [], characterDetectionBlacklist: [], locations: [],
    backgroundFolders: [], template: {}, collaboration: {}, metadata: {}, github: {},
  };
}

function fakeCache() {
  const store = new Map();
  return {
    async get(path) { return store.get(path) ?? null; },
    async set(path, entry) { store.set(path, entry); },
  };
}

// Task 7 (migration.test.js) established that plain jest.spyOn(apiClient, 'fn')
// does not work on this package's native-ESM named exports (read-only
// bindings) -- jest.unstable_mockModule is required instead. The mock module
// must be registered before anything that transitively imports apiClient.js
// is imported, so every other in-package import below is a dynamic import()
// that runs after the mock registration.
jest.unstable_mockModule('./apiClient.js', () => ({
  getRepo: jest.fn(),
  getRef: jest.fn(),
  updateRef: jest.fn(),
  createRef: jest.fn(),
  createBlob: jest.fn(),
  getBlob: jest.fn(),
  createTree: jest.fn(),
  getTree: jest.fn(),
  createCommit: jest.fn(),
  getCommit: jest.fn(),
  compareCommits: jest.fn(),
  bootstrapEmptyRepo: jest.fn(),
}));

const { pushSync } = await import('./sync.js');
const apiClient = await import('./apiClient.js');
const { projectBook } = await import('./project.js');
const { computeGitBlobSha } = await import('./blobSha.js');

// jest.restoreAllMocks() is a no-op for plain jest.fn() (it only restores
// spies created via jest.spyOn back to their original implementation) --
// these apiClient mocks are manually-created jest.fn()s from the
// unstable_mockModule factory above, module-level and shared across every
// test in this file. Without an explicit reset, mockResolvedValueOnce queues
// and mock.calls history from one test leak into the next, which silently
// corrupts the exact-call-count assertions below (the race-and-retry and
// maxRetries tests both assert precise updateRef call counts). Use
// resetAllMocks so each test starts every apiClient function with empty call
// history and no queued implementation.
afterEach(() => jest.resetAllMocks());

test('fast-forward push: remote unchanged since lastSyncCommitSha, no merge needed', async () => {
  apiClient.compareCommits.mockResolvedValue({ aheadBy: 0, behindBy: 0, mergeBaseSha: 'sync-sha' });
  apiClient.getRef.mockResolvedValue({ sha: 'sync-sha' });
  apiClient.getCommit.mockResolvedValue({ tree: { sha: 'remote-tree-sha' }, parents: [] });
  apiClient.getTree.mockResolvedValue([
    { path: 'book.json', type: 'blob', sha: 'old-book-json-sha' },
    { path: 'scenes/sc1.md', type: 'blob', sha: 'old-scene-sha' },
  ]);
  apiClient.createBlob.mockResolvedValue({ sha: 'new-blob-sha' });
  apiClient.createTree.mockResolvedValue({ sha: 'new-tree-sha' });
  apiClient.createCommit.mockResolvedValue({ sha: 'new-commit-sha' });
  apiClient.updateRef.mockResolvedValue({ ok: true });

  const book = makeBook('Edited Title');
  const result = await pushSync({
    repo: 'o/r', token: 't', branch: 'main', bookData: book,
    lastSyncCommitSha: 'sync-sha', cache: fakeCache(), author: { name: 'A', email: 'a@x.com' },
  });

  expect(result.commitSha).toBe('new-commit-sha');
  expect(result.conflicts).toEqual([]);
  expect(apiClient.updateRef).toHaveBeenCalledWith(expect.objectContaining({ sha: 'new-commit-sha', force: false }));
});

test('no-op guard: nothing actually changed relative to remote -- no blob/tree/commit created', async () => {
  apiClient.compareCommits.mockResolvedValue({ aheadBy: 0, behindBy: 0, mergeBaseSha: 'sync-sha' });
  apiClient.getRef.mockResolvedValue({ sha: 'sync-sha' });
  apiClient.getCommit.mockResolvedValue({ tree: { sha: 'remote-tree-sha' }, parents: [] });

  const book = makeBook('Same Title');
  const files = projectBook(book);
  const remoteEntries = [];
  for (const [path, { content, encoding }] of files) {
    remoteEntries.push({ path, type: 'blob', sha: await computeGitBlobSha(content, encoding) });
  }
  apiClient.getTree.mockResolvedValue(remoteEntries);

  const result = await pushSync({
    repo: 'o/r', token: 't', branch: 'main', bookData: book,
    lastSyncCommitSha: 'sync-sha', cache: fakeCache(), author: { name: 'A', email: 'a@x.com' },
  });

  expect(apiClient.createBlob).not.toHaveBeenCalled();
  expect(apiClient.createCommit).not.toHaveBeenCalled();
  expect(apiClient.updateRef).not.toHaveBeenCalled();
  expect(result.commitSha).toBe('sync-sha');
});

test('race-and-retry: first PATCH gets 422, retries on the new tip, and succeeds', async () => {
  apiClient.compareCommits.mockResolvedValue({ aheadBy: 0, behindBy: 0, mergeBaseSha: 'sync-sha' });
  apiClient.getRef
    .mockResolvedValueOnce({ sha: 'sync-sha' })       // initial read
    .mockResolvedValueOnce({ sha: 'someone-elses-new-tip' }); // re-fetch after 422
  apiClient.getCommit.mockResolvedValue({ tree: { sha: 'remote-tree-sha' }, parents: [] });
  apiClient.getTree.mockResolvedValue([
    { path: 'book.json', type: 'blob', sha: 'old-book-json-sha' },
    { path: 'scenes/sc1.md', type: 'blob', sha: 'old-scene-sha' },
  ]);
  apiClient.createBlob.mockResolvedValue({ sha: 'new-blob-sha' });
  apiClient.createTree.mockResolvedValue({ sha: 'new-tree-sha' });
  apiClient.createCommit.mockResolvedValue({ sha: 'new-commit-sha' });
  apiClient.updateRef
    .mockResolvedValueOnce({ ok: false, status: 422 })
    .mockResolvedValueOnce({ ok: true });

  const result = await pushSync({
    repo: 'o/r', token: 't', branch: 'main', bookData: makeBook('Retry Title'),
    lastSyncCommitSha: 'sync-sha', cache: fakeCache(), author: { name: 'A', email: 'a@x.com' },
  });

  expect(apiClient.updateRef).toHaveBeenCalledTimes(2);
  expect(result.commitSha).toBe('new-commit-sha');
});

test('gives up after maxRetries consecutive 422s rather than retrying forever', async () => {
  apiClient.compareCommits.mockResolvedValue({ aheadBy: 0, behindBy: 0, mergeBaseSha: 'sync-sha' });
  apiClient.getRef.mockResolvedValue({ sha: 'sync-sha' });
  apiClient.getCommit.mockResolvedValue({ tree: { sha: 'remote-tree-sha' }, parents: [] });
  apiClient.getTree.mockResolvedValue([
    { path: 'book.json', type: 'blob', sha: 'old-book-json-sha' },
    { path: 'scenes/sc1.md', type: 'blob', sha: 'old-scene-sha' },
  ]);
  apiClient.createBlob.mockResolvedValue({ sha: 'new-blob-sha' });
  apiClient.createTree.mockResolvedValue({ sha: 'new-tree-sha' });
  apiClient.createCommit.mockResolvedValue({ sha: 'new-commit-sha' });
  apiClient.updateRef.mockResolvedValue({ ok: false, status: 422 });

  await expect(pushSync({
    repo: 'o/r', token: 't', branch: 'main', bookData: makeBook('Never Lands'),
    lastSyncCommitSha: 'sync-sha', cache: fakeCache(), author: { name: 'A', email: 'a@x.com' }, maxRetries: 3,
  })).rejects.toThrow(/could not sync/i);

  expect(apiClient.updateRef).toHaveBeenCalledTimes(3);
});
