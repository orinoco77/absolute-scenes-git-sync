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

function withSceneRevision(book, { content, altContent }) {
  const scene = book.chapters[0].scenes[0];
  return {
    ...book,
    chapters: [
      {
        ...book.chapters[0],
        scenes: [
          {
            ...scene,
            content: content ?? scene.content,
            activeRevision: { id: 'r1', label: 'Revision 1', created: 'x' },
            revisions: [{ id: 'r2', label: 'Alt', created: 'y', content: altContent }]
          }
        ]
      }
    ]
  };
}

test('overlapping edits to an inactive revision report the scene id, not the revision file name', () => {
  const base = withSceneRevision(makeBook(), { altContent: 'alt line' });
  const local = withSceneRevision(makeBook(), { altContent: 'alt line local' });
  const remote = withSceneRevision(makeBook(), { altContent: 'alt line remote' });

  const { conflicts } = reconcilePostSyncState(base, local, remote);

  expect(conflicts).toEqual([{ sceneId: 'sc1' }]);
});

test('edits to different revision files of one scene merge without conflict', () => {
  const base = withSceneRevision(makeBook(), { altContent: 'alt line' });
  const local = withSceneRevision(makeBook(), {
    content: 'active edited locally',
    altContent: 'alt line'
  });
  const remote = withSceneRevision(makeBook(), { altContent: 'alt edited remotely' });

  const { bookData, conflicts } = reconcilePostSyncState(base, local, remote);

  expect(conflicts).toEqual([]);
  const scene = bookData.chapters[0].scenes[0];
  expect(scene.content).toBe('active edited locally');
  expect(scene.revisions[0].content).toBe('alt edited remotely');
});

// KNOWN LIMITATION (documented in README): switching draft moves a scene's
// file between `scenes/<id>.md` and `scenes/drafts/<draftId>/<id>.md`. Paths
// are merged independently, so an edit made elsewhere at the old path while
// this device switched drafts is not carried to the new path. This test pins
// today's behaviour; if cross-path merging is added, update it.
test('an edit to a scene whose draft was parked concurrently stays at the old path (known limitation)', () => {
  const base = {
    ...makeBook(),
    activeDraft: { id: 'd1', name: 'Draft 1', created: 'a' },
    drafts: [
      {
        id: 'd2',
        name: 'Draft 2',
        created: 'b',
        parts: [],
        chapters: [{ id: 'ch2', title: 'Chapter 1', scenes: [{ id: 'sc2', title: 'S', content: 'draft two' }] }]
      }
    ]
  };
  // This device switched to Draft 2: trees swap places.
  const local = {
    ...base,
    chapters: base.drafts[0].chapters,
    parts: [],
    activeDraft: { id: 'd2', name: 'Draft 2', created: 'b' },
    drafts: [{ id: 'd1', name: 'Draft 1', created: 'a', parts: [], chapters: base.chapters }]
  };
  // The sync result carries an edit to sc1 made on another device.
  const remote = {
    ...base,
    chapters: [
      {
        ...base.chapters[0],
        scenes: [{ ...base.chapters[0].scenes[0], content: 'edited elsewhere' }]
      }
    ]
  };

  const { bookData } = reconcilePostSyncState(base, local, remote);

  expect(bookData.activeDraft.id).toBe('d2');
  expect(bookData.chapters[0].scenes[0].content).toBe('draft two');
  const parked = bookData.drafts.find(d => d.id === 'd1');
  expect(parked.chapters[0].scenes[0].content).toBe('original content');
});

// KNOWN LIMITATION (documented in README): scenes/<id>.md always holds the
// ACTIVE revision, so switching revision rewrites that path with another
// revision's text. A concurrent edit to the previously active revision is
// then three-way merged into the newly active one, silently. Pinned here; if
// merging is made revision-aware, update this test.
test('an edit to a revision that was concurrently switched away from lands in the new active revision (known limitation)', () => {
  const r1Text = 'l1\nl2\nl3\nl4\nl5';
  const r2Text = 'l1 rewritten\nl2\nl3\nl4\nl5';
  const scene = makeBook().chapters[0].scenes[0];
  const withScene = s => ({ ...makeBook(), chapters: [{ ...makeBook().chapters[0], scenes: [s] }] });
  const base = withScene({
    ...scene,
    content: r1Text,
    activeRevision: { id: 'r1', label: 'Revision 1', created: 'x' },
    revisions: [{ id: 'r2', label: 'Alt', created: 'y', content: r2Text }]
  });
  const local = withScene({
    ...scene,
    content: r2Text,
    activeRevision: { id: 'r2', label: 'Alt', created: 'y' },
    revisions: [{ id: 'r1', label: 'Revision 1', created: 'x', content: r1Text }]
  });
  const remote = withScene({
    ...base.chapters[0].scenes[0],
    content: 'l1\nl2\nl3\nl4\nl5 REMOTE'
  });

  const { bookData, conflicts } = reconcilePostSyncState(base, local, remote);

  const merged = bookData.chapters[0].scenes[0];
  expect(conflicts).toEqual([]);
  expect(merged.activeRevision.id).toBe('r2');
  expect(merged.content).toBe('l1 rewritten\nl2\nl3\nl4\nl5 REMOTE');
  expect(merged.revisions.find(r => r.id === 'r1').content).toBe(r1Text);
});

// KNOWN LIMITATION (documented in README): activeDraft merges as one field
// while chapters and drafts[] merge by id, so two sides switching to
// DIFFERENT drafts leave one draft's chapters mixed into the active tree and
// that draft missing from drafts[]. Text survives; structure does not.
test('two sides switching to different drafts mixes their chapters (known limitation)', () => {
  const ch = id => ({ id, title: id, scenes: [{ id: `${id}-s`, title: 'S', content: id }] });
  const draft = (id, chapters) => ({ id, name: id, created: id, parts: [], chapters });
  const base = {
    ...makeBook(),
    chapters: [ch('c1')],
    activeDraft: { id: 'd1', name: 'd1', created: 'd1' },
    drafts: [draft('d2', [ch('c2')]), draft('d3', [ch('c3')])]
  };
  const local = {
    ...base,
    chapters: [ch('c2')],
    activeDraft: { id: 'd2', name: 'd2', created: 'd2' },
    drafts: [draft('d1', [ch('c1')]), draft('d3', [ch('c3')])]
  };
  const remote = {
    ...base,
    chapters: [ch('c3')],
    activeDraft: { id: 'd3', name: 'd3', created: 'd3' },
    drafts: [draft('d1', [ch('c1')]), draft('d2', [ch('c2')])]
  };

  const { bookData } = reconcilePostSyncState(base, local, remote);

  expect(bookData.activeDraft.id).toBe('d2');
  expect(bookData.chapters.map(c => c.id).sort()).toEqual(['c2', 'c3']);
  expect(bookData.drafts.map(d => d.id)).toEqual(['d1']);
});
