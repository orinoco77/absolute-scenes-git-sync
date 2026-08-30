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

export function projectBook(bookData) {
  const files = new Map();

  const chaptersForBookJson = (bookData.chapters ?? []).map(chapter => ({
    ...chapter,
    scenes: (chapter.scenes ?? []).map(scene => {
      const { content, ...sceneMeta } = scene;
      if (content !== undefined) {
        files.set(`scenes/${scene.id}.md`, { content, encoding: 'utf-8' });
      }
      return sceneMeta;
    }),
  }));

  const illustrationsForBookJson = (bookData.illustrations ?? []).map(illustration => {
    const { imageData, ...illustrationMeta } = illustration;
    if (imageData !== undefined) {
      const { ext, base64 } = parseDataUrl(imageData);
      files.set(`illustrations/${illustration.id}.${ext}`, { content: base64, encoding: 'base64' });
    }
    return illustrationMeta;
  });

  const { github, ...bookJsonRest } = bookData;
  const bookJson = {
    ...bookJsonRest,
    chapters: chaptersForBookJson,
    illustrations: illustrationsForBookJson,
  };

  files.set('book.json', { content: JSON.stringify(bookJson, null, 2), encoding: 'utf-8' });
  return files;
}

export function reassembleBook(files) {
  const bookJson = JSON.parse(files.get('book.json').content);

  const chapters = (bookJson.chapters ?? []).map(chapter => ({
    ...chapter,
    scenes: (chapter.scenes ?? []).map(scene => {
      const file = files.get(`scenes/${scene.id}.md`);
      return { ...scene, content: file ? file.content : '' };
    }),
  }));

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
    illustrations,
    github: {},
  };
}
