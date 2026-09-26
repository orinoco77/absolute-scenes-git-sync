import { rescueLocalContent } from './rescue.js';

const scene = (id, content, extra = {}) => ({ id, title: id, content, ...extra });
const book = (chapters, extra = {}) => ({ title: 'T', chapters, ...extra });

test('nothing to rescue when the remote already has every local scene with content', () => {
  const local = book([{ id: 'c1', title: 'C1', scenes: [scene('s1', 'local text')] }]);
  const remote = book([{ id: 'c1', title: 'C1', scenes: [scene('s1', 'remote text')] }]);
  const { rescued, bookData } = rescueLocalContent(local, remote);
  expect(rescued).toBe(false);
  expect(bookData).toBe(remote);
});

test('an empty remote scene is refilled from a non-empty local scene', () => {
  const local = book([{ id: 'c1', title: 'C1', scenes: [scene('s1', 'my work')] }]);
  const remote = book([{ id: 'c1', title: 'C1', scenes: [scene('s1', '')] }]);
  const { rescued, bookData } = rescueLocalContent(local, remote);
  expect(rescued).toBe(true);
  expect(bookData.chapters[0].scenes[0].content).toBe('my work');
});

test('a remote book with no chapters at all gets local chapters and scenes back', () => {
  const local = book([{ id: 'c1', title: 'C1', scenes: [scene('s1', 'a'), scene('s2', 'b')] }]);
  const remote = book([]);
  const { rescued, bookData } = rescueLocalContent(local, remote);
  expect(rescued).toBe(true);
  expect(bookData.chapters).toHaveLength(1);
  expect(bookData.chapters[0].scenes.map(s => s.content)).toEqual(['a', 'b']);
});

test('a scene missing from an existing remote chapter is appended to it', () => {
  const local = book([{ id: 'c1', title: 'C1', scenes: [scene('s1', 'a'), scene('s2', 'b')] }]);
  const remote = book([{ id: 'c1', title: 'C1', scenes: [scene('s1', 'a')] }]);
  const { bookData } = rescueLocalContent(local, remote);
  expect(bookData.chapters[0].scenes.map(s => s.id)).toEqual(['s1', 's2']);
});

test('a non-empty remote scene is never overwritten, and empty local scenes are not rescued', () => {
  const local = book([{ id: 'c1', title: 'C1', scenes: [scene('s1', 'stale local'), scene('s2', '')] }]);
  const remote = book([{ id: 'c1', title: 'C1', scenes: [scene('s1', 'newer remote')] }]);
  const { rescued, bookData } = rescueLocalContent(local, remote);
  expect(rescued).toBe(false);
  expect(bookData.chapters[0].scenes[0].content).toBe('newer remote');
});

test('a legacy local book (top-level scenes, no chapters) is rescued too', () => {
  const local = { title: 'T', scenes: [scene('s1', 'old format')] };
  const remote = book([]);
  const { rescued, bookData } = rescueLocalContent(local, remote);
  expect(rescued).toBe(true);
  expect(bookData.chapters[0].scenes[0].content).toBe('old format');
});

test('a local book with empty chapters but a populated top-level scenes array is rescued', () => {
  const local = { title: 'T', chapters: [], scenes: [scene('s1', 'old format')] };
  const { rescued } = rescueLocalContent(local, book([]));
  expect(rescued).toBe(true);
});

test('remote metadata (title, github) is kept', () => {
  const local = book([{ id: 'c1', title: 'C1', scenes: [scene('s1', 'a')] }], { title: 'Local title' });
  const remote = book([], { title: 'Remote title', github: {} });
  expect(rescueLocalContent(local, remote).bookData.title).toBe('Remote title');
});
