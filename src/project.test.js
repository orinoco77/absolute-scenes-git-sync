import { projectBook, reassembleBook, sceneIdFromPath } from './project.js';

function makeBook(overrides = {}) {
  return {
    title: 'Test Book',
    author: 'Test Author',
    frontMatter: [],
    backMatter: [],
    parts: [],
    chapters: [
      {
        id: 'ch1',
        title: 'Chapter One',
        scenes: [
          {
            id: 'sc1',
            title: 'Scene One',
            content: 'Once upon a time.\n\nThe end of scene one.',
            notes: 'some notes',
            created: '2026-01-01T00:00:00Z',
            modified: '2026-01-02T00:00:00Z',
            assignedAuthor: 'Alice',
          },
        ],
      },
    ],
    illustrations: [],
    characters: [],
    characterDetectionBlacklist: [],
    locations: [],
    backgroundFolders: [],
    template: { fontFamily: 'Georgia' },
    collaboration: { enabled: true, authors: ['Alice'], currentAuthor: 'Alice' },
    metadata: { created: '2026-01-01T00:00:00Z' },
    github: {},
    ...overrides,
  };
}

test('round-trips a typical book losslessly', () => {
  const book = makeBook();
  const files = projectBook(book);
  const restored = reassembleBook(files);
  expect(restored).toEqual(book);
});

test('scene content is projected verbatim, with no transformation', () => {
  const book = makeBook();
  const files = projectBook(book);
  expect(files.get('scenes/sc1.md')).toEqual({
    content: 'Once upon a time.\n\nThe end of scene one.',
    encoding: 'utf-8',
  });
});

test('book.json omits scene content and github.* local bookkeeping', () => {
  const book = makeBook();
  const files = projectBook(book);
  const bookJson = JSON.parse(files.get('book.json').content);
  expect(bookJson.chapters[0].scenes[0].content).toBeUndefined();
  expect(bookJson.github).toBeUndefined();
  // non-content scene fields are still present in book.json
  expect(bookJson.chapters[0].scenes[0].title).toBe('Scene One');
  expect(bookJson.chapters[0].scenes[0].notes).toBe('some notes');
});

test('reassembleBook fills github.* with empty defaults (caller is responsible for local sync bookkeeping)', () => {
  const book = makeBook({ github: { repository: 'owner/repo', lastSyncCommitSha: 'deadbeef' } });
  const files = projectBook(book);
  const restored = reassembleBook(files);
  // github.* was never in the projected files, so on reassembly it comes back
  // empty -- the sync orchestration layer (Task 8/9) is responsible for
  // setting github.repository / lastSyncCommitSha itself, not this function.
  expect(restored.github).toEqual({});
});

test('round-trips illustrations as separate binary files with mime-derived extensions', () => {
  const book = makeBook({
    illustrations: [
      {
        id: 'illus1',
        pageNumber: 3,
        imageData: 'data:image/png;base64,aGVsbG8=', // "hello"
      },
    ],
  });
  const files = projectBook(book);
  expect(files.get('illustrations/illus1.png')).toEqual({
    content: 'aGVsbG8=',
    encoding: 'base64',
  });
  const bookJson = JSON.parse(files.get('book.json').content);
  expect(bookJson.illustrations[0].imageData).toBeUndefined();
  expect(bookJson.illustrations[0].pageNumber).toBe(3);

  const restored = reassembleBook(files);
  expect(restored.illustrations[0].imageData).toBe('data:image/png;base64,aGVsbG8=');
  expect(restored.illustrations[0].pageNumber).toBe(3);
});

test('handles a book with zero scenes and zero illustrations', () => {
  const book = makeBook({ chapters: [{ id: 'ch1', title: 'Empty Chapter', scenes: [] }] });
  const files = projectBook(book);
  expect([...files.keys()].some(p => p.startsWith('scenes/'))).toBe(false);
  const restored = reassembleBook(files);
  expect(restored).toEqual(book);
});

test('projects a pre-chapters legacy book (top-level `scenes`, no `chapters`) instead of silently discarding its content', () => {
  // Real books saved by app versions that predate the chapters migration
  // store their content under a top-level `scenes` array, not `chapters`.
  // projectBook used to read only `bookData.chapters ?? []`, so a legacy
  // book like this projected to zero scene files and an empty chapters
  // list in book.json -- confirmed data loss when this flows through
  // migrateLegacyRepo, which commits that empty projection straight over
  // the real content on GitHub.
  const legacyBook = {
    title: 'Old Book',
    scenes: [
      { id: 'sc1', title: 'Scene One', content: 'Real prose that must survive.', notes: '', created: '', modified: '', assignedAuthor: '' },
    ],
    illustrations: [],
    github: {},
  };

  const files = projectBook(legacyBook);

  expect(files.get('scenes/sc1.md')).toEqual({
    content: 'Real prose that must survive.',
    encoding: 'utf-8',
  });
  const bookJson = JSON.parse(files.get('book.json').content);
  expect(bookJson.chapters).toHaveLength(1);
  expect(bookJson.chapters[0].scenes).toHaveLength(1);
  expect(bookJson.scenes).toBeUndefined(); // folded into chapters, not duplicated

  const restored = reassembleBook(files);
  expect(restored.chapters[0].scenes[0].content).toBe('Real prose that must survive.');
});

test('round-trips multiple chapters and scenes with distinct content', () => {
  const book = makeBook({
    chapters: [
      { id: 'ch1', title: 'One', scenes: [{ id: 'sc1', title: 'A', content: 'first', notes: '', created: '', modified: '', assignedAuthor: '' }] },
      { id: 'ch2', title: 'Two', scenes: [
        { id: 'sc2', title: 'B', content: 'second', notes: '', created: '', modified: '', assignedAuthor: '' },
        { id: 'sc3', title: 'C', content: 'third', notes: '', created: '', modified: '', assignedAuthor: '' },
      ] },
    ],
  });
  const files = projectBook(book);
  expect(files.get('scenes/sc1.md').content).toBe('first');
  expect(files.get('scenes/sc2.md').content).toBe('second');
  expect(files.get('scenes/sc3.md').content).toBe('third');
  expect(reassembleBook(files)).toEqual(book);
});

test('projectBook falls back to top-level scenes when chapters is present but empty', () => {
  const files = projectBook({ title: 'T', chapters: [], scenes: [{ id: 's1', title: 'S', content: 'text' }] });
  expect(files.get('scenes/s1.md').content).toBe('text');
  expect(JSON.parse(files.get('book.json').content).chapters[0].scenes[0].id).toBe('s1');
});

const bookWithDraftsAndRevisions = () => ({
  title: 'T',
  chapters: [
    {
      id: 'c1',
      title: 'C1',
      scenes: [
        {
          id: 's1',
          title: 'One',
          content: 'active text',
          activeRevision: { id: 'r1', label: 'Revision 1', created: 'x' },
          revisions: [{ id: 'r2', label: 'Alt', created: 'y', content: 'alt text' }]
        }
      ]
    }
  ],
  parts: [],
  activeDraft: { id: 'd1', name: 'Draft 1', created: 'a' },
  drafts: [
    {
      id: 'd2',
      name: 'Draft 2',
      created: 'b',
      parts: [],
      chapters: [
        {
          id: 'c2',
          title: 'C1',
          scenes: [
            {
              id: 's2',
              title: 'One',
              content: 'draft two text',
              activeRevision: { id: 'r3', label: 'Revision 1', created: 'z' },
              revisions: [{ id: 'r4', label: 'Other', created: 'w', content: 'draft two alt' }]
            }
          ]
        }
      ]
    }
  ],
  illustrations: []
});

test('projects revisions and inactive drafts to per-file markdown', () => {
  const files = projectBook(bookWithDraftsAndRevisions());
  expect(files.get('scenes/s1.md').content).toBe('active text');
  expect(files.get('scenes/s1.rev-r2.md').content).toBe('alt text');
  expect(files.get('scenes/drafts/d2/s2.md').content).toBe('draft two text');
  expect(files.get('scenes/drafts/d2/s2.rev-r4.md').content).toBe('draft two alt');
  const bookJson = JSON.parse(files.get('book.json').content);
  expect(JSON.stringify(bookJson)).not.toMatch(/alt text|draft two/);
  expect(bookJson.drafts[0].id).toBe('d2');
});

test('reassembleBook restores drafts and revisions exactly', () => {
  const book = bookWithDraftsAndRevisions();
  const back = reassembleBook(projectBook(book));
  expect(back.chapters).toEqual(book.chapters);
  expect(back.drafts).toEqual(book.drafts);
  expect(back.activeDraft).toEqual(book.activeDraft);
});

test('a book without drafts or revisions projects exactly as before', () => {
  const files = projectBook({ chapters: [{ id: 'c', title: 'C', scenes: [{ id: 's', title: 'S', content: 'x' }] }] });
  expect([...files.keys()].sort()).toEqual(['book.json', 'scenes/s.md']);
});

test('sceneIdFromPath strips folders, extension and revision suffix', () => {
  expect(sceneIdFromPath('scenes/s1.md')).toBe('s1');
  expect(sceneIdFromPath('scenes/s1.rev-r2.md')).toBe('s1');
  expect(sceneIdFromPath('scenes/drafts/d2/s2.rev-r4.md')).toBe('s2');
});
