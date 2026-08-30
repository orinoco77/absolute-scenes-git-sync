import { jest } from '@jest/globals';

function makeBook(title = 'Book', sceneContent = 'prose') {
  return {
    title, author: 'A', frontMatter: [], backMatter: [], parts: [],
    chapters: [{ id: 'ch1', title: 'C1', scenes: [{ id: 'sc1', title: 'S1', content: sceneContent, notes: '', created: '', modified: '', assignedAuthor: '' }] }],
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

// GitHub's real blob API always reports content as base64, regardless of the
// original encoding at write time -- these merge-branch tests rely on that
// contract to distinguish a correct decode from the Finding-1 regression
// (sniffing blob.encoding, which is always 'base64', instead of the path).
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  return btoa(String.fromCharCode(...bytes));
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

const { pushSync, pullSync } = await import('./sync.js');
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

test('genuine 3-way merge: scene content changed on both sides since the merge base, merges cleanly', async () => {
  // Same fixture as mergeScene.test.js's "append at the bottom vs insert in
  // the middle" case, routed through the full pushSync flow this time.
  const baseSceneContent = 'Paragraph one.\nParagraph two.\nParagraph three.';
  const localSceneContent = baseSceneContent + '\nParagraph four, added by A at the bottom.';
  const remoteSceneContent = 'Paragraph one.\nInserted by B between one and two.\nParagraph two.\nParagraph three.';
  const expectedMergedContent =
    'Paragraph one.\nInserted by B between one and two.\nParagraph two.\nParagraph three.\nParagraph four, added by A at the bottom.';

  const book = makeBook('Title', localSceneContent);
  const bookJsonContent = projectBook(book).get('book.json').content;

  apiClient.compareCommits.mockResolvedValue({ aheadBy: 1, behindBy: 1, mergeBaseSha: 'base-commit-sha' });
  apiClient.getRef.mockResolvedValue({ sha: 'remote-commit-sha' });
  apiClient.getCommit.mockImplementation(async ({ sha }) => {
    if (sha === 'remote-commit-sha') return { tree: { sha: 'remote-tree-sha' }, parents: ['base-commit-sha'] };
    if (sha === 'base-commit-sha') return { tree: { sha: 'base-tree-sha' }, parents: [] };
    throw new Error(`unexpected getCommit sha: ${sha}`);
  });
  apiClient.getTree.mockImplementation(async ({ sha }) => {
    if (sha === 'remote-tree-sha') {
      return [
        // book.json identical to base -- keeps this test isolated to the scene merge
        { path: 'book.json', type: 'blob', sha: 'unchanged-book-json-sha' },
        { path: 'scenes/sc1.md', type: 'blob', sha: 'remote-scene-sha' },
      ];
    }
    if (sha === 'base-tree-sha') {
      return [
        { path: 'book.json', type: 'blob', sha: 'unchanged-book-json-sha' },
        { path: 'scenes/sc1.md', type: 'blob', sha: 'base-scene-sha' },
      ];
    }
    throw new Error(`unexpected getTree sha: ${sha}`);
  });
  apiClient.getBlob.mockImplementation(async ({ sha }) => {
    if (sha === 'base-scene-sha') return { content: utf8ToBase64(baseSceneContent), encoding: 'base64' };
    if (sha === 'remote-scene-sha') return { content: utf8ToBase64(remoteSceneContent), encoding: 'base64' };
    throw new Error(`unexpected getBlob sha: ${sha}`);
  });
  apiClient.createBlob.mockResolvedValue({ sha: 'new-blob-sha' });
  apiClient.createTree.mockResolvedValue({ sha: 'new-tree-sha' });
  apiClient.createCommit.mockResolvedValue({ sha: 'new-commit-sha' });
  apiClient.updateRef.mockResolvedValue({ ok: true });

  const result = await pushSync({
    repo: 'o/r', token: 't', branch: 'main', bookData: book,
    lastSyncCommitSha: 'sync-sha', cache: fakeCache(), author: { name: 'A', email: 'a@x.com' },
  });

  expect(result.conflicts).toEqual([]);
  expect(result.bookData.chapters[0].scenes[0].content).toBe(expectedMergedContent);

  const sceneBlobCall = apiClient.createBlob.mock.calls.find(([args]) => args.encoding === 'utf-8' && args.content === expectedMergedContent);
  expect(sceneBlobCall).toBeDefined();

  // book.json's own content string is unused here beyond confirming the
  // fixture shape -- the merge target is the scene, not the metadata.
  expect(bookJsonContent).toContain('"id": "sc1"');
});

test('genuine 3-way merge: book.json metadata changed on both sides, merges without crashing on JSON.parse', async () => {
  const baseBook = makeBook('Base Title');
  const localBook = makeBook('Local Title');
  const remoteBook = makeBook('Remote Title');

  const baseBookJsonContent = projectBook(baseBook).get('book.json').content;
  const remoteBookJsonContent = projectBook(remoteBook).get('book.json').content;

  apiClient.compareCommits.mockResolvedValue({ aheadBy: 1, behindBy: 1, mergeBaseSha: 'base-commit-sha' });
  apiClient.getRef.mockResolvedValue({ sha: 'remote-commit-sha' });
  apiClient.getCommit.mockImplementation(async ({ sha }) => {
    if (sha === 'remote-commit-sha') return { tree: { sha: 'remote-tree-sha' }, parents: ['base-commit-sha'] };
    if (sha === 'base-commit-sha') return { tree: { sha: 'base-tree-sha' }, parents: [] };
    throw new Error(`unexpected getCommit sha: ${sha}`);
  });
  apiClient.getTree.mockImplementation(async ({ sha }) => {
    if (sha === 'remote-tree-sha') {
      return [
        { path: 'book.json', type: 'blob', sha: 'remote-book-json-sha' },
        // scene unchanged on remote since base -- keeps this test isolated to book.json
        { path: 'scenes/sc1.md', type: 'blob', sha: 'unchanged-scene-sha' },
      ];
    }
    if (sha === 'base-tree-sha') {
      return [
        { path: 'book.json', type: 'blob', sha: 'base-book-json-sha' },
        { path: 'scenes/sc1.md', type: 'blob', sha: 'unchanged-scene-sha' },
      ];
    }
    throw new Error(`unexpected getTree sha: ${sha}`);
  });
  apiClient.getBlob.mockImplementation(async ({ sha }) => {
    if (sha === 'base-book-json-sha') return { content: utf8ToBase64(baseBookJsonContent), encoding: 'base64' };
    if (sha === 'remote-book-json-sha') return { content: utf8ToBase64(remoteBookJsonContent), encoding: 'base64' };
    throw new Error(`unexpected getBlob sha: ${sha}`);
  });
  apiClient.createBlob.mockResolvedValue({ sha: 'new-blob-sha' });
  apiClient.createTree.mockResolvedValue({ sha: 'new-tree-sha' });
  apiClient.createCommit.mockResolvedValue({ sha: 'new-commit-sha' });
  apiClient.updateRef.mockResolvedValue({ ok: true });

  const result = await pushSync({
    repo: 'o/r', token: 't', branch: 'main', bookData: localBook,
    lastSyncCommitSha: 'sync-sha', cache: fakeCache(), author: { name: 'A', email: 'a@x.com' },
  });

  // both sides changed the title differently -- mergeBookMetadata's tie-break
  // in pushSync favors local on a genuine conflict.
  expect(result.bookData.title).toBe('Local Title');
  expect(apiClient.updateRef).toHaveBeenCalledWith(expect.objectContaining({ sha: 'new-commit-sha' }));
});

test('pullSync fetches the current tree and reassembles bookData, using the cache to skip unchanged blobs', async () => {
  apiClient.getRef.mockResolvedValue({ sha: 'remote-sha' });
  apiClient.getCommit.mockResolvedValue({ tree: { sha: 'remote-tree-sha' }, parents: [] });
  apiClient.getTree.mockResolvedValue([
    { path: 'book.json', type: 'blob', sha: 'book-json-sha' },
    { path: 'scenes/sc1.md', type: 'blob', sha: 'scene-sha' },
  ]);
  const bookJson = JSON.stringify({
    title: 'Pulled Book', author: '', frontMatter: [], backMatter: [], parts: [],
    chapters: [{ id: 'ch1', title: 'C1', scenes: [{ id: 'sc1', title: 'S1', notes: '', created: '', modified: '', assignedAuthor: '' }] }],
    illustrations: [], characters: [], characterDetectionBlacklist: [], locations: [], backgroundFolders: [], template: {}, collaboration: {}, metadata: {},
  });
  apiClient.getBlob.mockImplementation(async ({ sha }) => {
    if (sha === 'book-json-sha') return { content: utf8ToBase64(bookJson), encoding: 'base64' };
    if (sha === 'scene-sha') return { content: utf8ToBase64('pulled scene content'), encoding: 'base64' };
    throw new Error('unexpected sha');
  });

  const cache = fakeCache();

  const result = await pullSync({ repo: 'o/r', token: 't', branch: 'main', cache });
  expect(result.commitSha).toBe('remote-sha');
  expect(result.bookData.title).toBe('Pulled Book');
  expect(result.bookData.chapters[0].scenes[0].content).toBe('pulled scene content');
  expect(apiClient.getBlob).toHaveBeenCalledTimes(2);
});

test('pullSync skips fetching a blob whose sha is already in the cache', async () => {
  apiClient.getRef.mockResolvedValue({ sha: 'remote-sha' });
  apiClient.getCommit.mockResolvedValue({ tree: { sha: 'remote-tree-sha' }, parents: [] });
  apiClient.getTree.mockResolvedValue([
    { path: 'book.json', type: 'blob', sha: 'book-json-sha' },
  ]);
  const bookJson = JSON.stringify({
    title: 'Cached Book', author: '', frontMatter: [], backMatter: [], parts: [], chapters: [],
    illustrations: [], characters: [], characterDetectionBlacklist: [], locations: [], backgroundFolders: [], template: {}, collaboration: {}, metadata: {},
  });

  const cache = (() => {
    const store = new Map([['book.json', { sha: 'book-json-sha', content: bookJson, encoding: 'utf-8' }]]);
    return { async get(p) { return store.get(p) ?? null; }, async set(p, e) { store.set(p, e); } };
  })();

  const result = await pullSync({ repo: 'o/r', token: 't', branch: 'main', cache });
  expect(apiClient.getBlob).not.toHaveBeenCalled();
  expect(result.bookData.title).toBe('Cached Book');
});
