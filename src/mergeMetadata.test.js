import { mergeBookMetadata } from './mergeMetadata.js';

function baseBook() {
  return {
    title: 'Original Title',
    author: 'Alice',
    frontMatter: [],
    backMatter: [],
    parts: [],
    chapters: [
      { id: 'ch1', title: 'Chapter One', scenes: [{ id: 'sc1', title: 'Scene A', notes: '', created: '', modified: '', assignedAuthor: '' }] },
    ],
    characters: [{ id: 'char1', name: 'Alice' }],
    characterDetectionBlacklist: ['the', 'and'],
    locations: [],
    backgroundFolders: [],
    illustrations: [],
    template: { fontFamily: 'Georgia' },
    collaboration: { enabled: true, authors: ['Alice'], currentAuthor: 'Alice' },
    metadata: { created: '2026-01-01T00:00:00Z' },
  };
}

test('unchanged fields pass through unmodified', () => {
  const base = baseBook();
  const result = mergeBookMetadata(base, base, base, 'local');
  expect(result).toEqual(base);
});

test('a scalar field changed on only one side is taken as-is', () => {
  const base = baseBook();
  const local = { ...base, title: 'New Title From Local' };
  const result = mergeBookMetadata(base, local, base, 'local');
  expect(result.title).toBe('New Title From Local');
});

test('a scalar field changed differently on both sides uses tieBreak', () => {
  const base = baseBook();
  const local = { ...base, title: 'Local Title' };
  const remote = { ...base, title: 'Remote Title' };
  expect(mergeBookMetadata(base, local, remote, 'local').title).toBe('Local Title');
  expect(mergeBookMetadata(base, local, remote, 'remote').title).toBe('Remote Title');
});

test('a chapter added by only local is kept (union, not dropped)', () => {
  const base = baseBook();
  const newChapter = { id: 'ch2', title: 'New Chapter', scenes: [] };
  const local = { ...base, chapters: [...base.chapters, newChapter] };
  const result = mergeBookMetadata(base, local, base, 'local');
  expect(result.chapters).toHaveLength(2);
  expect(result.chapters.find(c => c.id === 'ch2')).toEqual(newChapter);
});

test('different chapters added independently by both sides are both kept', () => {
  const base = baseBook();
  const localChapter = { id: 'ch-local', title: 'Local New', scenes: [] };
  const remoteChapter = { id: 'ch-remote', title: 'Remote New', scenes: [] };
  const local = { ...base, chapters: [...base.chapters, localChapter] };
  const remote = { ...base, chapters: [...base.chapters, remoteChapter] };
  const result = mergeBookMetadata(base, local, remote, 'local');
  expect(result.chapters).toHaveLength(3);
  expect(result.chapters.map(c => c.id).sort()).toEqual(['ch-local', 'ch-remote', 'ch1']);
});

test('a chapter deleted by one side and untouched by the other is removed', () => {
  const base = baseBook();
  const local = { ...base, chapters: [] };
  const result = mergeBookMetadata(base, local, base, 'local');
  expect(result.chapters).toHaveLength(0);
});

test('a chapter deleted by one side but edited by the other side survives with the edit (deletion loses to an edit)', () => {
  const base = baseBook();
  const local = { ...base, chapters: [] };
  const remote = {
    ...base,
    chapters: [{ ...base.chapters[0], title: 'Edited, not deleted' }],
  };
  const result = mergeBookMetadata(base, local, remote, 'local');
  expect(result.chapters).toHaveLength(1);
  expect(result.chapters[0].title).toBe('Edited, not deleted');
});

test('scenes within a chapter merge the same way, recursively, without ever touching content', () => {
  const base = baseBook();
  const newScene = { id: 'sc2', title: 'Scene B', notes: '', created: '', modified: '', assignedAuthor: '' };
  const local = {
    ...base,
    chapters: [{ ...base.chapters[0], scenes: [...base.chapters[0].scenes, newScene] }],
  };
  const result = mergeBookMetadata(base, local, base, 'local');
  expect(result.chapters[0].scenes).toHaveLength(2);
  expect(result.chapters[0].scenes.find(s => s.id === 'sc2')).toEqual(newScene);
  // no scene in this function's input/output ever carries `content`
  expect(result.chapters[0].scenes.every(s => !('content' in s))).toBe(true);
});

test('characterDetectionBlacklist merges as a deduplicated set union, not last-write-wins', () => {
  const base = baseBook();
  const local = { ...base, characterDetectionBlacklist: ['the', 'and', 'but'] };
  const remote = { ...base, characterDetectionBlacklist: ['the', 'and', 'or'] };
  const result = mergeBookMetadata(base, local, remote, 'local');
  expect(result.characterDetectionBlacklist.sort()).toEqual(['and', 'but', 'or', 'the']);
});

test('template and collaboration objects use whole-object tieBreak when both sides changed them', () => {
  const base = baseBook();
  const local = { ...base, template: { fontFamily: 'Local Font' } };
  const remote = { ...base, template: { fontFamily: 'Remote Font' } };
  expect(mergeBookMetadata(base, local, remote, 'remote').template.fontFamily).toBe('Remote Font');
});

test('illustrations merge the same way as other id-keyed arrays (union of additions)', () => {
  const base = baseBook();
  const newIllustration = { id: 'illus1', pageNumber: 3 };
  const local = { ...base, illustrations: [...base.illustrations, newIllustration] };
  const result = mergeBookMetadata(base, local, base, 'local');
  expect(result.illustrations).toHaveLength(1);
  expect(result.illustrations[0]).toEqual(newIllustration);
});

test('preserves activeRevision and revision metadata through a merge', () => {
  const scene = { id: 's', title: 'S', notes: '', created: 'c', modified: 'm', assignedAuthor: null,
    activeRevision: { id: 'r1', label: 'Revision 1', created: 'x' },
    revisions: [{ id: 'r2', label: 'Alt', created: 'y' }] };
  const base = { chapters: [{ id: 'c', title: 'C', scenes: [scene] }] };
  const merged = mergeBookMetadata(base, base, base, 'local');
  expect(merged.chapters[0].scenes[0].activeRevision).toEqual(scene.activeRevision);
  expect(merged.chapters[0].scenes[0].revisions).toEqual(scene.revisions);
});

test('merges drafts and activeDraft by id, and keeps unknown top-level fields', () => {
  const base = { title: 'T', activeDraft: { id: 'd1', name: 'Draft 1', created: 'a' }, drafts: [], futureField: 1 };
  const local = { ...base, drafts: [{ id: 'd2', name: 'Two', created: 'b', chapters: [], parts: [] }] };
  const remote = { ...base, activeDraft: { id: 'd1', name: 'Renamed', created: 'a' } };
  const merged = mergeBookMetadata(base, local, remote, 'local');
  expect(merged.drafts.map(d => d.id)).toEqual(['d2']);
  expect(merged.activeDraft.name).toBe('Renamed');
  expect(merged.futureField).toBe(1);
});

test('a revision added on each side is kept from both', () => {
  const mk = revs => ({ chapters: [{ id: 'c', title: 'C', scenes: [{ id: 's', title: 'S', revisions: revs }] }] });
  const base = mk([]);
  const local = mk([{ id: 'a', label: 'A', created: '1' }]);
  const remote = mk([{ id: 'b', label: 'B', created: '2' }]);
  const merged = mergeBookMetadata(base, local, remote, 'local');
  expect(merged.chapters[0].scenes[0].revisions.map(r => r.id).sort()).toEqual(['a', 'b']);
});
