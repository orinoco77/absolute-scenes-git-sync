const MIME_TO_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

function parseDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) {
    throw new Error(`Expected a base64 data URL, got: ${dataUrl.slice(0, 40)}...`);
  }
  const [, mime, base64] = match;
  const ext = MIME_TO_EXT[mime] ?? 'bin';
  return { mime, ext, base64 };
}

// A book's chapters, falling back to a legacy top-level `scenes` array when
// `chapters` is absent OR present-but-empty (old files can carry both, with
// the real content only in `scenes`).
export function chaptersWithLegacyFallback(bookData) {
  if (bookData.chapters?.length) return bookData.chapters;
  if (bookData.scenes?.length) {
    return [{ id: 'default', title: 'Chapter 1', scenes: bookData.scenes }];
  }
  return bookData.chapters ?? [];
}

// Scene text lives at scenes/<prefix><sceneId>.md; an inactive revision's
// text at scenes/<prefix><sceneId>.rev-<revId>.md. prefix is '' for the
// active draft and 'drafts/<draftId>/' for inactive drafts.
const scenePath = (prefix, sceneId) => `scenes/${prefix}${sceneId}.md`;
const revPath = (prefix, sceneId, revId) => `scenes/${prefix}${sceneId}.rev-${revId}.md`;

export function sceneIdFromPath(path) {
  const name = path.split('/').pop().replace(/\.md$/, '');
  return name.replace(/\.rev-.*$/, '');
}

function projectChapters(chapters, prefix, files) {
  return chapters.map(chapter => ({
    ...chapter,
    scenes: (chapter.scenes ?? []).map(scene => {
      const { content, revisions, ...sceneMeta } = scene;
      if (content !== undefined) {
        files.set(scenePath(prefix, scene.id), { content, encoding: 'utf-8' });
      }
      if (revisions) {
        sceneMeta.revisions = revisions.map(rev => {
          const { content: revContent, ...revMeta } = rev;
          if (revContent !== undefined) {
            files.set(revPath(prefix, scene.id, rev.id), { content: revContent, encoding: 'utf-8' });
          }
          return revMeta;
        });
      }
      return sceneMeta;
    }),
  }));
}

function assembleChapters(chapters, prefix, files) {
  return (chapters ?? []).map(chapter => ({
    ...chapter,
    scenes: (chapter.scenes ?? []).map(scene => {
      const file = files.get(scenePath(prefix, scene.id));
      const rebuilt = { ...scene, content: file ? file.content : '' };
      if (scene.revisions) {
        rebuilt.revisions = scene.revisions.map(rev => {
          const revFile = files.get(revPath(prefix, scene.id, rev.id));
          return { ...rev, content: revFile ? revFile.content : '' };
        });
      }
      return rebuilt;
    }),
  }));
}

export function projectBook(bookData) {
  const files = new Map();

  // Books saved by app versions that predate the chapters migration store
  // their content under a top-level `scenes` array instead of `chapters`.
  // Without this fallback, `bookData.chapters ?? []` silently treats such a
  // book as having zero chapters -- confirmed data loss when this flows
  // through migrateLegacyRepo, which commits that empty projection straight
  // over the real content already on GitHub. Mirrors the equivalent
  // migration desktop's own local-load path already applies.
  const chapters = chaptersWithLegacyFallback(bookData);

  const chaptersForBookJson = projectChapters(chapters, '', files);

  // Inactive drafts' scene text lives under scenes/drafts/<draftId>/.
  const draftsForBookJson = bookData.drafts
    ? bookData.drafts.map(draft => ({
        ...draft,
        chapters: projectChapters(draft.chapters ?? [], `drafts/${draft.id}/`, files),
      }))
    : undefined;

  const illustrationsForBookJson = (bookData.illustrations ?? []).map(illustration => {
    const { imageData, ...illustrationMeta } = illustration;
    if (imageData !== undefined) {
      const { ext, base64 } = parseDataUrl(imageData);
      files.set(`illustrations/${illustration.id}.${ext}`, { content: base64, encoding: 'base64' });
    }
    return illustrationMeta;
  });

  const { github, scenes: _legacyScenes, ...bookJsonRest } = bookData;
  const bookJson = {
    ...bookJsonRest,
    chapters: chaptersForBookJson,
    ...(draftsForBookJson ? { drafts: draftsForBookJson } : {}),
    illustrations: illustrationsForBookJson,
  };

  files.set('book.json', { content: JSON.stringify(bookJson, null, 2), encoding: 'utf-8' });
  return files;
}

export function reassembleBook(files) {
  const bookJson = JSON.parse(files.get('book.json').content);

  const chapters = assembleChapters(bookJson.chapters, '', files);
  const drafts = bookJson.drafts
    ? bookJson.drafts.map(draft => ({
        ...draft,
        chapters: assembleChapters(draft.chapters, `drafts/${draft.id}/`, files),
      }))
    : undefined;

  const illustrations = (bookJson.illustrations ?? []).map(illustration => {
    const found = [...files.keys()].find(path => path.startsWith(`illustrations/${illustration.id}.`));
    const file = found ? files.get(found) : null;
    const ext = found ? found.split('.').pop() : null;
    const mime = ext ? (Object.entries(MIME_TO_EXT).find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream') : 'application/octet-stream';
    return {
      ...illustration,
      imageData: file ? `data:${mime};base64,${file.content}` : undefined,
    };
  });

  return {
    ...bookJson,
    chapters,
    ...(drafts ? { drafts } : {}),
    illustrations,
    github: {},
  };
}
