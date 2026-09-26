import { jest } from '@jest/globals';
import { makeFakeGitHub } from './fakeGitHub.js';
import { syncRepo } from './syncRepo.js';
import { projectBook } from './project.js';

// End-to-end regression for the data-loss reproduced with a real old-format
// .book: opening it on a device with no lastSyncCommitSha, against a repo
// already on the new layout but hollowed out by the earlier migration bug.
// Runs the real syncRepo/pullSync/pushSync against an in-memory GitHub.

const realGlobalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realGlobalFetch; });

const author = { name: 'a', email: 'a@example.com' };
const memoryCache = () => {
  const m = new Map();
  return { async get(p) { return m.get(p) ?? null; }, async set(p, e) { m.set(p, e); } };
};

function makeLocalBook() {
  return {
    title: 'Old Book', author: 'A',
    chapters: [
      { id: 'c1', title: 'One', scenes: [{ id: 's1', title: 'S1', content: 'first scene prose' }, { id: 's2', title: 'S2', content: 'second scene prose' }] },
      { id: 'c2', title: 'Two', scenes: [{ id: 's3', title: 'S3', content: 'third scene prose' }] },
    ],
    illustrations: [], characters: [], locations: [], scenes: [], github: {},
  };
}

const textFiles = book => new Map([...projectBook(book)].map(([k, v]) => [k, v.content]));
const sceneContents = book => book.chapters.flatMap(c => c.scenes).map(s => s.content);

function seed(gh, mode) {
  const local = makeLocalBook();
  const legacy = gh.commitFiles(new Map([['Old Book.book', JSON.stringify(local)]]), [], 'legacy');
  const { scenes: _s, github: _g, ...hollowBook } = local;
  const files = textFiles(mode === 'no-chapters' ? { ...hollowBook, chapters: [] } : hollowBook);
  for (const k of [...files.keys()]) {
    if (!k.startsWith('scenes/')) continue;
    if (mode === 'empty-scenes') files.set(k, '');
    else files.delete(k);
  }
  gh.refs.set('main', gh.commitFiles(files, [legacy], 'hollow'));
  return local;
}

describe.each(['no-chapters', 'empty-scenes', 'missing-scene-files'])('first sync against a hollowed new-layout remote (%s)', mode => {
  test('local content survives and is pushed back to the remote', async () => {
    const gh = makeFakeGitHub();
    globalThis.fetch = gh.fetchImpl;
    const local = seed(gh, mode);

    const result = await syncRepo({
      repo: 'o/r', token: 't', branch: 'main', bookData: local,
      lastSyncCommitSha: undefined, cache: memoryCache(), author,
    });

    expect(sceneContents(result.bookData).sort()).toEqual(
      ['first scene prose', 'second scene prose', 'third scene prose']
    );
    expect(result.conflicts).toEqual([]);
    const remote = gh.headFiles();
    expect(remote.get('scenes/s1.md')).toBe('first scene prose');
    expect(remote.get('scenes/s3.md')).toBe('third scene prose');
  });
});
