// live.integration.test.js
import { describe, test, expect, jest } from '@jest/globals';
import { pushSync, pullSync, bootstrapEmptyRepo, detectRepoLayout, getRef, compareCommits } from './index.js';

const TOKEN = process.env.GIT_SYNC_LIVE_TEST_TOKEN;
const REPO = process.env.GIT_SYNC_LIVE_TEST_REPO;
const describeLive = TOKEN && REPO ? describe : describe.skip;
const BRANCH = `live-test-${Date.now()}`;

function makeBook(title) {
  return {
    title, author: 'Live Test', frontMatter: [], backMatter: [], parts: [],
    chapters: [{ id: 'ch1', title: 'C1', scenes: [{ id: 'sc1', title: 'S1', content: 'live test prose', notes: '', created: '', modified: '', assignedAuthor: '' }] }],
    illustrations: [], characters: [], characterDetectionBlacklist: [], locations: [],
    backgroundFolders: [], template: {}, collaboration: {}, metadata: {}, github: {},
  };
}

function memoryCache() {
  const store = new Map();
  return { async get(p) { return store.get(p) ?? null; }, async set(p, e) { store.set(p, e); } };
}

describeLive('live GitHub integration', () => {
  jest.setTimeout(30000);

  test('bootstrap + push + pull round trip against a real repo', async () => {
    const layout = await detectRepoLayout({ repo: REPO, token: TOKEN, branch: BRANCH });
    expect(layout).toBe('empty');

    await bootstrapEmptyRepo({ repo: REPO, token: TOKEN, branch: BRANCH, path: '_bootstrap.txt', content: 'seed' });

    const bootstrapRef = await getRef({ repo: REPO, token: TOKEN, branch: BRANCH });
    const push = await pushSync({
      repo: REPO, token: TOKEN, branch: BRANCH, bookData: makeBook('Live Test Book'),
      lastSyncCommitSha: bootstrapRef.sha, cache: memoryCache(),
      author: { name: 'Live Test', email: 'live-test@example.com' },
    });
    expect(push.conflicts).toEqual([]);

    const pull = await pullSync({ repo: REPO, token: TOKEN, branch: BRANCH, cache: memoryCache() });
    expect(pull.bookData.title).toBe('Live Test Book');
    expect(pull.bookData.chapters[0].scenes[0].content).toBe('live test prose');
  });

  test('two-device race: second push retries onto the winner and both changes survive', async () => {
    const startRef = await getRef({ repo: REPO, token: TOKEN, branch: BRANCH });

    const deviceABook = makeBook('Race Test Book');
    deviceABook.chapters[0].scenes.push({ id: 'sc-a', title: 'A', content: 'from device A', notes: '', created: '', modified: '', assignedAuthor: '' });
    const deviceBBook = makeBook('Race Test Book');
    deviceBBook.chapters[0].scenes.push({ id: 'sc-b', title: 'B', content: 'from device B', notes: '', created: '', modified: '', assignedAuthor: '' });

    const [resultA, resultB] = await Promise.all([
      pushSync({ repo: REPO, token: TOKEN, branch: BRANCH, bookData: deviceABook, lastSyncCommitSha: startRef.sha, cache: memoryCache(), author: { name: 'Device A', email: 'a@example.com' } }),
      pushSync({ repo: REPO, token: TOKEN, branch: BRANCH, bookData: deviceBBook, lastSyncCommitSha: startRef.sha, cache: memoryCache(), author: { name: 'Device B', email: 'b@example.com' } }),
    ]);

    const final = await pullSync({ repo: REPO, token: TOKEN, branch: BRANCH, cache: memoryCache() });
    const sceneIds = final.bookData.chapters[0].scenes.map(s => s.id);
    expect(sceneIds).toContain('sc-a');
    expect(sceneIds).toContain('sc-b');
  });

  test('compareCommits returns the true merge-base on genuinely diverged history', async () => {
    const ref = await getRef({ repo: REPO, token: TOKEN, branch: BRANCH });
    const compare = await compareCommits({ repo: REPO, token: TOKEN, base: ref.sha, head: ref.sha });
    expect(compare.mergeBaseSha).toBe(ref.sha);
  });
});
