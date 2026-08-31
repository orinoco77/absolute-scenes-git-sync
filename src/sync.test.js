import { jest } from '@jest/globals';

function makeBook(title = 'Book', sceneContent = 'prose') {
  return {
    title, author: 'A', frontMatter: [], backMatter: [], parts: [],
    chapters: [{ id: 'ch1', title: 'C1', scenes: [{ id: 'sc1', title: 'S1', content: sceneContent, notes: '', created: '', modified: '', assignedAuthor: '' }] }],
    illustrations: [], characters: [], characterDetectionBlacklist: [], locations: [],
    backgroundFolders: [], template: {}, collaboration: {}, metadata: {}, github: {},
  };
}

// Returns a copy of `book` with one illustration attached, so tests can
// exercise buildAttempt's binary/illustration merge branch alongside the
// scene/book.json coverage above.
function withIllustration(book, imageBase64) {
  return { ...book, illustrations: [{ id: 'illus1', imageData: `data:image/png;base64,${imageBase64}` }] };
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
    { path: 'illustrations/illus1.png', type: 'blob', sha: 'old-illustration-sha' },
  ]);
  apiClient.createBlob.mockResolvedValue({ sha: 'new-blob-sha' });
  apiClient.createTree.mockResolvedValue({ sha: 'new-tree-sha' });
  apiClient.createCommit.mockResolvedValue({ sha: 'new-commit-sha' });
  apiClient.updateRef.mockResolvedValue({ ok: true });

  // Quadrant 2 ("only local changed") exercised for all three path kinds at
  // once: base and remote tree entries above are identical fake shas that
  // no real computed sha will ever match, so book.json, the scene, and the
  // illustration all register as locally-changed-only and should be pushed
  // as-is, unmerged.
  const illustrationBase64 = utf8ToBase64('local-image-bytes');
  const book = withIllustration(makeBook('Edited Title'), illustrationBase64);
  const result = await pushSync({
    repo: 'o/r', token: 't', branch: 'main', bookData: book,
    lastSyncCommitSha: 'sync-sha', cache: fakeCache(), author: { name: 'A', email: 'a@x.com' },
  });

  expect(result.commitSha).toBe('new-commit-sha');
  expect(result.conflicts).toEqual([]);
  expect(result.bookData.illustrations[0].imageData).toBe(`data:image/png;base64,${illustrationBase64}`);
  expect(apiClient.updateRef).toHaveBeenCalledWith(expect.objectContaining({ sha: 'new-commit-sha', force: false }));

  const illustrationBlobCall = apiClient.createBlob.mock.calls.find(([args]) => args.encoding === 'base64' && args.content === illustrationBase64);
  expect(illustrationBlobCall).toBeDefined();
});

test('no-op guard: nothing actually changed relative to remote -- no blob/tree/commit created', async () => {
  apiClient.compareCommits.mockResolvedValue({ aheadBy: 0, behindBy: 0, mergeBaseSha: 'sync-sha' });
  apiClient.getRef.mockResolvedValue({ sha: 'sync-sha' });
  apiClient.getCommit.mockResolvedValue({ tree: { sha: 'remote-tree-sha' }, parents: [] });

  // Includes an illustration so this quadrant-1 ("neither side changed")
  // coverage spans scenes/*.md, book.json, AND a binary path -- the binary
  // merge branch had zero test coverage before this fix.
  const book = withIllustration(makeBook('Same Title'), utf8ToBase64('same-image-bytes'));
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

test('remote-only-new-file regression: a scene added by another device (never seen locally) is adopted with its real content, not reset to empty', async () => {
  // buildAttempt's main loop only walks localFiles -- paths the local book
  // already knows about. A file that exists on remote but was never in
  // local's own projection at all (a scene another device added, that this
  // device has never seen) has no entry driving that loop, so it was never
  // fetched into mergedFiles. The old "deleted locally" loop only reinstates
  // paths that also existed at the merge base -- a genuinely new-since-base
  // remote file fell through both loops entirely. reassembleBook then still
  // lists the scene (its metadata rides along inside book.json, which *is*
  // adopted from remote) but with content defaulting to '' since the file
  // itself was never in the merged map -- real, live-reproduced data loss,
  // not a hypothetical.
  const localSceneContent = 'scene1 content, untouched';
  const remoteOnlySceneContent = 'sceneB content from another device';

  const localBook = makeBook('Shared Title', localSceneContent); // only has sc1 -- has never heard of sceneB

  const bookJsonBaseContent = projectBook(localBook).get('book.json').content;
  const bookJsonBaseSha = await computeGitBlobSha(bookJsonBaseContent, 'utf-8');
  const sc1Sha = await computeGitBlobSha(localSceneContent, 'utf-8');
  const sceneBSha = await computeGitBlobSha(remoteOnlySceneContent, 'utf-8');

  // Remote's book.json now lists both scenes (someone else pushed sceneB) --
  // its content differs from base/local's book.json only by that addition.
  const remoteBookJson = JSON.parse(bookJsonBaseContent);
  remoteBookJson.chapters[0].scenes.push({ id: 'sceneB', title: 'Scene B', notes: '', created: '', modified: '', assignedAuthor: '' });
  const remoteBookJsonContent = JSON.stringify(remoteBookJson, null, 2);
  const remoteBookJsonSha = await computeGitBlobSha(remoteBookJsonContent, 'utf-8');

  apiClient.compareCommits.mockResolvedValue({ aheadBy: 1, behindBy: 0, mergeBaseSha: 'base-commit-sha' });
  apiClient.getRef.mockResolvedValue({ sha: 'remote-commit-sha' });
  apiClient.getCommit.mockImplementation(async ({ sha }) => {
    if (sha === 'remote-commit-sha') return { tree: { sha: 'remote-tree-sha' }, parents: ['base-commit-sha'] };
    if (sha === 'base-commit-sha') return { tree: { sha: 'base-tree-sha' }, parents: [] };
    throw new Error(`unexpected getCommit sha: ${sha}`);
  });
  apiClient.getTree.mockImplementation(async ({ sha }) => {
    if (sha === 'remote-tree-sha') {
      return [
        { path: 'book.json', type: 'blob', sha: remoteBookJsonSha },
        { path: 'scenes/sc1.md', type: 'blob', sha: sc1Sha },
        { path: 'scenes/sceneB.md', type: 'blob', sha: sceneBSha }, // new since base
      ];
    }
    if (sha === 'base-tree-sha') {
      return [
        { path: 'book.json', type: 'blob', sha: bookJsonBaseSha },
        { path: 'scenes/sc1.md', type: 'blob', sha: sc1Sha },
      ];
    }
    throw new Error(`unexpected getTree sha: ${sha}`);
  });
  apiClient.getBlob.mockImplementation(async ({ sha }) => {
    if (sha === remoteBookJsonSha) return { content: utf8ToBase64(remoteBookJsonContent), encoding: 'base64' };
    if (sha === sceneBSha) return { content: utf8ToBase64(remoteOnlySceneContent), encoding: 'base64' };
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

  const sceneB = result.bookData.chapters[0].scenes.find(s => s.id === 'sceneB');
  expect(sceneB).toBeDefined();
  expect(sceneB.content).toBe(remoteOnlySceneContent);
  expect(result.bookData.chapters[0].scenes.find(s => s.id === 'sc1').content).toBe(localSceneContent);

  // Nothing to push back -- this device didn't change anything; it just
  // needed to learn about sceneB. A no-op push must not fabricate a delete
  // or a duplicate blob for a file that's already correct on remote.
  const treeCall = apiClient.createTree.mock.calls[0]?.[0];
  if (treeCall) {
    expect(treeCall.entries.some(e => e.path === 'scenes/sceneB.md' && e.sha === null)).toBe(false);
  }
});

test('quadrant 3 regression: local left a scene untouched, remote changed it -- remote content is adopted, not reverted', async () => {
  // This is the regression test for the Critical bug caught in final
  // review: buildAttempt's original branching set `mergedFiles.set(path,
  // local)` whenever `!localChanged`, with no case for "only remote
  // changed" -- so an untouched-locally scene that a collaborator had
  // edited on remote would be silently reverted to base/local's stale
  // content and pushed as a real commit doing so. Mixes in an
  // only-local-changed book.json title so the test also exercises a real
  // push (not just the no-op path) alongside the untouched-but-remote-
  // changed scene.
  const baseSceneContent = 'Chapter opens quietly.\nA door creaks.';
  const localSceneContent = baseSceneContent; // untouched locally
  const remoteSceneContent = baseSceneContent + '\nA collaborator added this line remotely.';

  const baseBook = makeBook('Base Title', baseSceneContent);
  const localBook = makeBook('Local Title', localSceneContent); // only the title changed locally

  const bookJsonBaseContent = projectBook(baseBook).get('book.json').content; // same content on remote -- title untouched there
  const sceneBaseSha = await computeGitBlobSha(baseSceneContent, 'utf-8');
  const sceneRemoteSha = await computeGitBlobSha(remoteSceneContent, 'utf-8');
  const bookJsonBaseSha = await computeGitBlobSha(bookJsonBaseContent, 'utf-8');

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
        { path: 'book.json', type: 'blob', sha: bookJsonBaseSha }, // unchanged remotely
        { path: 'scenes/sc1.md', type: 'blob', sha: sceneRemoteSha }, // changed remotely
      ];
    }
    if (sha === 'base-tree-sha') {
      return [
        { path: 'book.json', type: 'blob', sha: bookJsonBaseSha },
        { path: 'scenes/sc1.md', type: 'blob', sha: sceneBaseSha },
      ];
    }
    throw new Error(`unexpected getTree sha: ${sha}`);
  });
  apiClient.getBlob.mockImplementation(async ({ sha }) => {
    if (sha === sceneRemoteSha) return { content: utf8ToBase64(remoteSceneContent), encoding: 'base64' };
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

  // The critical assertion: remote's edit survives, it is not reverted.
  expect(result.bookData.chapters[0].scenes[0].content).toBe(remoteSceneContent);
  // The caller's own, unrelated local edit (the title) still goes through.
  expect(result.bookData.title).toBe('Local Title');
  expect(result.commitSha).toBe('new-commit-sha');

  // The pushed tree must not contain a scenes/sc1.md entry reverting it back
  // to base/local's stale content -- adopting remote's own existing content
  // for that path needs no new blob, so it should be entirely absent from
  // the tree entries sent to createTree (the base_tree carries it forward).
  const treeCall = apiClient.createTree.mock.calls[0][0];
  expect(treeCall.entries.some(e => e.path === 'scenes/sc1.md')).toBe(false);
});

test('quadrant 3 regression: local left an illustration untouched, remote changed it -- remote content is adopted, not reverted, no-op push', async () => {
  const baseImage = utf8ToBase64('base-image-bytes');
  const localImage = baseImage; // untouched locally
  const remoteImage = utf8ToBase64('remote-image-bytes');

  const book = withIllustration(makeBook('Same Title'), localImage);
  const bookJsonContent = projectBook(book).get('book.json').content;
  const bookJsonSha = await computeGitBlobSha(bookJsonContent, 'utf-8');
  const sceneSha = await computeGitBlobSha('prose', 'utf-8');
  const baseIllustrationSha = await computeGitBlobSha(baseImage, 'base64');
  const remoteIllustrationSha = await computeGitBlobSha(remoteImage, 'base64');

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
        { path: 'book.json', type: 'blob', sha: bookJsonSha },
        { path: 'scenes/sc1.md', type: 'blob', sha: sceneSha },
        { path: 'illustrations/illus1.png', type: 'blob', sha: remoteIllustrationSha }, // changed remotely
      ];
    }
    if (sha === 'base-tree-sha') {
      return [
        { path: 'book.json', type: 'blob', sha: bookJsonSha },
        { path: 'scenes/sc1.md', type: 'blob', sha: sceneSha },
        { path: 'illustrations/illus1.png', type: 'blob', sha: baseIllustrationSha },
      ];
    }
    throw new Error(`unexpected getTree sha: ${sha}`);
  });
  apiClient.getBlob.mockImplementation(async ({ sha }) => {
    if (sha === remoteIllustrationSha) return { content: remoteImage, encoding: 'base64' };
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

  expect(result.bookData.illustrations[0].imageData).toBe(`data:image/png;base64,${remoteImage}`);
  // Every path resolves to exactly what's already on remote -- a true no-op.
  expect(apiClient.createBlob).not.toHaveBeenCalled();
  expect(apiClient.updateRef).not.toHaveBeenCalled();
  expect(result.commitSha).toBe('remote-commit-sha');
});

test('directory-entry regression: GitHub\'s recursive tree listing includes a "scenes" directory entry alongside the blobs -- adding a new scene must not delete an untouched sibling scene file', async () => {
  // GitHub's real `git/trees/:sha?recursive=1` response includes an entry
  // for the intermediate directory itself (type: 'tree'), not just the
  // blobs under it -- verified live, not a guess. projectBook never
  // produces a literal 'scenes' key (only 'scenes/<id>.md'), so treating
  // every remote-tree path as a real file whose absence from localFiles
  // means "deleted locally" makes buildAttempt schedule a delete for the
  // literal path 'scenes' every single push. GitHub's createTree API
  // applies that as "remove whatever's at this path" -- wiping the entire
  // scenes/ subtree -- and only the scene that actually changed this push
  // gets re-added afterward, silently deleting every other scene file.
  const unchangedSceneContent = 'This scene was never touched.';
  const book = makeBook('Same Title', unchangedSceneContent);
  book.chapters[0].scenes.push({
    id: 'sc2', title: 'New Scene', content: 'Brand new scene.', notes: '', created: '', modified: '', assignedAuthor: '',
  });

  const bookJsonBaseContent = projectBook(makeBook('Same Title', unchangedSceneContent)).get('book.json').content;
  const bookJsonBaseSha = await computeGitBlobSha(bookJsonBaseContent, 'utf-8');
  const sc1Sha = await computeGitBlobSha(unchangedSceneContent, 'utf-8');

  apiClient.compareCommits.mockResolvedValue({ aheadBy: 0, behindBy: 0, mergeBaseSha: 'sync-sha' });
  apiClient.getRef.mockResolvedValue({ sha: 'sync-sha' });
  apiClient.getCommit.mockResolvedValue({ tree: { sha: 'shared-tree-sha' }, parents: [] });
  apiClient.getTree.mockResolvedValue([
    { path: 'book.json', type: 'blob', sha: bookJsonBaseSha },
    { path: 'scenes', type: 'tree', sha: 'directory-entry-sha' }, // the trap
    { path: 'scenes/sc1.md', type: 'blob', sha: sc1Sha }, // untouched by this push
  ]);
  apiClient.createBlob.mockResolvedValue({ sha: 'new-blob-sha' });
  apiClient.createTree.mockResolvedValue({ sha: 'new-tree-sha' });
  apiClient.createCommit.mockResolvedValue({ sha: 'new-commit-sha' });
  apiClient.updateRef.mockResolvedValue({ ok: true });

  const result = await pushSync({
    repo: 'o/r', token: 't', branch: 'main', bookData: book,
    lastSyncCommitSha: 'sync-sha', cache: fakeCache(), author: { name: 'A', email: 'a@x.com' },
  });

  // The critical assertion: the untouched scene is not scheduled for
  // deletion just because "scenes" (the directory marker, not a real file)
  // isn't one of projectBook's output paths.
  const treeCall = apiClient.createTree.mock.calls[0][0];
  expect(treeCall.entries.some(e => e.path === 'scenes' && e.sha === null)).toBe(false);

  // And the merged bookData handed back to the caller still has both scenes.
  const sceneIds = result.bookData.chapters[0].scenes.map(s => s.id);
  expect(sceneIds).toEqual(expect.arrayContaining(['sc1', 'sc2']));
  expect(result.bookData.chapters[0].scenes.find(s => s.id === 'sc1').content).toBe(unchangedSceneContent);
});

test('quadrant 4: an illustration changed on both sides -- remote wins (binary conflicts have no merge strategy)', async () => {
  const baseImage = utf8ToBase64('base-image-bytes');
  const localImage = utf8ToBase64('local-image-bytes');
  const remoteImage = utf8ToBase64('remote-image-bytes');

  const book = withIllustration(makeBook('Same Title'), localImage);
  const bookJsonContent = projectBook(book).get('book.json').content;
  const bookJsonSha = await computeGitBlobSha(bookJsonContent, 'utf-8');
  const sceneSha = await computeGitBlobSha('prose', 'utf-8');
  const baseIllustrationSha = await computeGitBlobSha(baseImage, 'base64');
  const remoteIllustrationSha = await computeGitBlobSha(remoteImage, 'base64');

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
        { path: 'book.json', type: 'blob', sha: bookJsonSha },
        { path: 'scenes/sc1.md', type: 'blob', sha: sceneSha },
        { path: 'illustrations/illus1.png', type: 'blob', sha: remoteIllustrationSha }, // changed remotely
      ];
    }
    if (sha === 'base-tree-sha') {
      return [
        { path: 'book.json', type: 'blob', sha: bookJsonSha },
        { path: 'scenes/sc1.md', type: 'blob', sha: sceneSha },
        { path: 'illustrations/illus1.png', type: 'blob', sha: baseIllustrationSha },
      ];
    }
    throw new Error(`unexpected getTree sha: ${sha}`);
  });
  apiClient.getBlob.mockImplementation(async ({ sha }) => {
    if (sha === remoteIllustrationSha) return { content: remoteImage, encoding: 'base64' };
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

  // Both sides changed the illustration differently -- remote wins, local's
  // edit is discarded (there is no way to merge binary content).
  expect(result.bookData.illustrations[0].imageData).toBe(`data:image/png;base64,${remoteImage}`);
  expect(result.bookData.illustrations[0].imageData).not.toBe(`data:image/png;base64,${localImage}`);
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
