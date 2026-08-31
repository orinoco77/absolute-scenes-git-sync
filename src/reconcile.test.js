import { reconcilePostSyncState } from './reconcile.js';

function makeBook() {
  return {
    title: 'T',
    author: 'A',
    frontMatter: [],
    backMatter: [],
    parts: [],
    chapters: [
      {
        id: 'ch1',
        title: 'Chapter 1',
        scenes: [
          {
            id: 'sc1',
            title: 'Scene 1',
            content: 'original content',
            notes: '',
            created: '',
            modified: '',
            assignedAuthor: ''
          }
        ]
      }
    ],
    illustrations: [],
    characters: [],
    characterDetectionBlacklist: [],
    locations: [],
    backgroundFolders: [],
    template: {},
    collaboration: {},
    metadata: {},
    github: { repository: { full_name: 'o/r' }, lastSyncCommitSha: 'old-sha' }
  };
}

function withNewScene(book, scene) {
  return {
    ...book,
    chapters: book.chapters.map(ch =>
      ch.id === 'ch1' ? { ...ch, scenes: [...ch.scenes, scene] } : ch
    )
  };
}

test('fast path: identical reference for base and local returns the sync result untouched', () => {
  const base = makeBook();
  const remote = { ...makeBook(), title: 'Synced Title' };
  const { bookData, conflicts } = reconcilePostSyncState(base, base, remote);
  expect(bookData).toBe(remote);
  expect(conflicts).toEqual([]);
});

test('a scene added locally while the sync was in flight survives, not just the sync result', () => {
  const base = makeBook();
  const local = withNewScene(base, {
    id: 'sc2',
    title: 'Scene 2',
    content: 'added mid-flight',
    notes: '',
    created: '',
    modified: '',
    assignedAuthor: ''
  });
  const remote = {
    ...base,
    title: 'Synced Title',
    github: { ...base.github, lastSyncCommitSha: 'new-sha' }
  };

  const { bookData, conflicts } = reconcilePostSyncState(base, local, remote);

  expect(conflicts).toEqual([]);
  expect(bookData.title).toBe('Synced Title');
  const scenes = bookData.chapters[0].scenes;
  expect(scenes.find(s => s.id === 'sc1').content).toBe('original content');
  const sc2 = scenes.find(s => s.id === 'sc2');
  expect(sc2).toBeDefined();
  expect(sc2.content).toBe('added mid-flight');
  expect(bookData.github.lastSyncCommitSha).toBe('new-sha');
});

test('a scene deleted locally while the sync was in flight stays deleted', () => {
  const base = makeBook();
  const local = {
    ...base,
    chapters: [{ ...base.chapters[0], scenes: [] }]
  };
  const remote = { ...base, title: 'Synced Title' };

  const { bookData } = reconcilePostSyncState(base, local, remote);

  expect(bookData.chapters[0].scenes).toHaveLength(0);
  expect(bookData.title).toBe('Synced Title');
});

test('editing content on a scene both mid-flight locally and via the sync result merges, flagging a conflict only on real overlap', () => {
  const base = makeBook();
  const local = {
    ...base,
    chapters: [
      {
        ...base.chapters[0],
        scenes: [
          {
            ...base.chapters[0].scenes[0],
            content: 'original content\nlocal addition at the end'
          }
        ]
      }
    ]
  };
  const remote = {
    ...base,
    chapters: [
      {
        ...base.chapters[0],
        scenes: [
          {
            ...base.chapters[0].scenes[0],
            content: 'remote addition at the start\noriginal content'
          }
        ]
      }
    ]
  };

  const { bookData, conflicts } = reconcilePostSyncState(base, local, remote);

  expect(conflicts).toEqual([]);
  expect(bookData.chapters[0].scenes[0].content).toBe(
    'remote addition at the start\noriginal content\nlocal addition at the end'
  );
});

test('an illustration changed both mid-flight locally and by the sync result prefers the more recent local edit', () => {
  const base = {
    ...makeBook(),
    illustrations: [
      { id: 'illus1', imageData: 'data:image/png;base64,YmFzZQ==' }
    ]
  };
  const local = {
    ...base,
    illustrations: [
      { id: 'illus1', imageData: 'data:image/png;base64,bG9jYWw=' }
    ]
  };
  const remote = {
    ...base,
    illustrations: [
      { id: 'illus1', imageData: 'data:image/png;base64,cmVtb3Rl' }
    ]
  };

  const { bookData } = reconcilePostSyncState(base, local, remote);

  expect(bookData.illustrations[0].imageData).toBe(
    'data:image/png;base64,bG9jYWw='
  );
});
