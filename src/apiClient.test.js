import {
  getRepo, getRef, updateRef, createRef, createBlob, getBlob,
  createTree, getTree, createCommit, getCommit, compareCommits, bootstrapEmptyRepo,
} from './apiClient.js';
// getBlob is exercised directly below (GitHub's blob API always returns
// content as base64 regardless of how it was created — this is the
// contract sync.js's atob_utf8 helper relies on, so it's locked in here).

function mockFetchOnce(status, body) {
  const calls = [];
  global.fetch = Object.assign(
    async (...args) => {
      calls.push(args);
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      };
    },
    { mock: { calls } }
  );
}

afterEach(() => {
  delete global.fetch;
});

test('every request disables browser HTTP caching (cache: "no-store") -- GitHub API GET responses must never be served stale', async () => {
  // Real bug found live: the pushSync retry loop's repeated getRef/getCommit
  // calls could be served a stale cached response by the browser's default
  // fetch caching, so a retry after a 422 kept rebuilding from the SAME
  // stale parent instead of the true current tip -- exhausting all 5
  // retries with false-negative 422s even after an earlier attempt's push
  // had already landed for real. This exact class of bug was independently
  // found and partially fixed in the sibling mobile codebase before this
  // package existed (see SYNC_DIAGNOSIS.md's uncommitted-diff notes).
  mockFetchOnce(200, { object: { sha: 'abc123' } });
  await getRef({ repo: 'owner/repo', token: 't', branch: 'main' });
  const [, options] = global.fetch.mock.calls[0];
  expect(options.cache).toBe('no-store');
});

test('getRepo returns default branch and permissions', async () => {
  mockFetchOnce(200, { default_branch: 'main', private: true, permissions: { push: true } });
  const result = await getRepo({ repo: 'owner/repo', token: 't' });
  expect(result).toEqual({ defaultBranch: 'main', private: true, permissions: { push: true } });
  const [url, options] = global.fetch.mock.calls[0];
  expect(url).toBe('https://api.github.com/repos/owner/repo');
  expect(options.headers.Authorization).toBe('Bearer t');
});

test('getRef returns the sha on success', async () => {
  mockFetchOnce(200, { object: { sha: 'abc123' } });
  const result = await getRef({ repo: 'owner/repo', token: 't', branch: 'main' });
  expect(result).toEqual({ sha: 'abc123' });
});

test('getRef returns null on 404 (branch does not exist yet)', async () => {
  mockFetchOnce(404, { message: 'Not Found' });
  const result = await getRef({ repo: 'owner/repo', token: 't', branch: 'main' });
  expect(result).toBeNull();
});

test('getRef returns null on 409 "Git Repository is empty" (a truly empty repo, zero commits) -- real GitHub response, not a guess', async () => {
  // This exact response body was observed live against a real empty scratch
  // repo during design verification (spec section 9): GitHub returns 409,
  // not 404, when looking up any ref on a repository with zero commits.
  mockFetchOnce(409, {
    message: 'Git Repository is empty.',
    documentation_url: 'https://docs.github.com/rest/git/refs#get-a-reference',
  });
  const result = await getRef({ repo: 'owner/repo', token: 't', branch: 'main' });
  expect(result).toBeNull();
});

test('updateRef returns ok:true on 200', async () => {
  mockFetchOnce(200, { object: { sha: 'new-sha' } });
  const result = await updateRef({ repo: 'owner/repo', token: 't', branch: 'main', sha: 'new-sha', force: false });
  expect(result).toEqual({ ok: true });
});

test('updateRef returns ok:false, status:422 on a non-fast-forward rejection -- does not throw', async () => {
  mockFetchOnce(422, { message: 'Update is not a fast forward' });
  const result = await updateRef({ repo: 'owner/repo', token: 't', branch: 'main', sha: 'new-sha', force: false });
  expect(result).toEqual({ ok: false, status: 422 });
});

test('createBlob sends the exact encoding and content given, returns sha', async () => {
  mockFetchOnce(201, { sha: 'blob-sha' });
  const result = await createBlob({ repo: 'owner/repo', token: 't', content: 'hello', encoding: 'utf-8' });
  expect(result).toEqual({ sha: 'blob-sha' });
  const [, options] = global.fetch.mock.calls[0];
  expect(JSON.parse(options.body)).toEqual({ content: 'hello', encoding: 'utf-8' });
});

test('createTree sends base_tree and entries, supports sha:null for deletion', async () => {
  mockFetchOnce(201, { sha: 'tree-sha' });
  await createTree({
    repo: 'owner/repo',
    token: 't',
    baseTree: 'base-tree-sha',
    entries: [
      { path: 'book.json', mode: '100644', type: 'blob', sha: 'blob-sha' },
      { path: 'old-file.txt', mode: '100644', type: 'blob', sha: null },
    ],
  });
  const [, options] = global.fetch.mock.calls[0];
  const body = JSON.parse(options.body);
  expect(body.base_tree).toBe('base-tree-sha');
  expect(body.tree).toEqual([
    { path: 'book.json', mode: '100644', type: 'blob', sha: 'blob-sha' },
    { path: 'old-file.txt', mode: '100644', type: 'blob', sha: null },
  ]);
});

test('createCommit sends a single parent and real author identity', async () => {
  mockFetchOnce(201, { sha: 'commit-sha' });
  await createCommit({
    repo: 'owner/repo', token: 't', message: 'msg', tree: 'tree-sha',
    parents: ['parent-sha'], author: { name: 'Alice', email: 'alice@example.com' },
  });
  const [, options] = global.fetch.mock.calls[0];
  const body = JSON.parse(options.body);
  expect(body.parents).toEqual(['parent-sha']);
  expect(body.author).toEqual({ name: 'Alice', email: 'alice@example.com' });
});

test('compareCommits returns mergeBaseSha, aheadBy, behindBy', async () => {
  mockFetchOnce(200, { ahead_by: 1, behind_by: 1, merge_base_commit: { sha: 'base-sha' } });
  const result = await compareCommits({ repo: 'owner/repo', token: 't', base: 'b', head: 'h' });
  expect(result).toEqual({ aheadBy: 1, behindBy: 1, mergeBaseSha: 'base-sha' });
});

test('compareCommits returns null when base no longer exists in history', async () => {
  mockFetchOnce(404, { message: 'Not Found' });
  const result = await compareCommits({ repo: 'owner/repo', token: 't', base: 'gone', head: 'h' });
  expect(result).toBeNull();
});

test('bootstrapEmptyRepo uses the Contents API, not Git Data API', async () => {
  mockFetchOnce(201, { commit: { sha: 'bootstrap-sha' } });
  const result = await bootstrapEmptyRepo({
    repo: 'owner/repo', token: 't', branch: 'main', path: '_bootstrap.txt', content: 'seed',
  });
  expect(result).toEqual({ commitSha: 'bootstrap-sha' });
  const [url, options] = global.fetch.mock.calls[0];
  expect(url).toBe('https://api.github.com/repos/owner/repo/contents/_bootstrap.txt');
  expect(options.method).toBe('PUT');
});

test('getBlob returns content and encoding exactly as GitHub reports them', async () => {
  mockFetchOnce(200, { content: 'aGVsbG8=', encoding: 'base64' });
  const result = await getBlob({ repo: 'owner/repo', token: 't', sha: 'blob-sha' });
  expect(result).toEqual({ content: 'aGVsbG8=', encoding: 'base64' });
  const [url] = global.fetch.mock.calls[0];
  expect(url).toBe('https://api.github.com/repos/owner/repo/git/blobs/blob-sha');
});

test('getTree fetches recursively and returns path/type/sha entries', async () => {
  mockFetchOnce(200, { tree: [{ path: 'book.json', type: 'blob', sha: 's1' }, { path: 'scenes', type: 'tree', sha: 's2' }] });
  const result = await getTree({ repo: 'owner/repo', token: 't', sha: 'tree-sha' });
  expect(result).toEqual([{ path: 'book.json', type: 'blob', sha: 's1' }, { path: 'scenes', type: 'tree', sha: 's2' }]);
  const [url] = global.fetch.mock.calls[0];
  expect(url).toContain('recursive=1');
});

test('a non-2xx, non-404/422 response throws with the status attached', async () => {
  mockFetchOnce(500, { message: 'Server Error' });
  await expect(getRepo({ repo: 'owner/repo', token: 't' })).rejects.toMatchObject({ status: 500 });
});
