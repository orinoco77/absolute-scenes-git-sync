import { chaptersWithLegacyFallback } from './project.js';

const hasContent = scene => typeof scene.content === 'string' && scene.content.length > 0;

// Compares this device's book against what a first-sync pull just brought
// down, and puts back any non-empty scene content the remote lacks (scene
// missing entirely, or present with empty content). Remote content is never
// overwritten -- a first sync has no merge base, so where both sides have
// text the remote wins, exactly as the plain pull always did. Only the
// "remote is empty/absent, local has writing" case is rescued, since that is
// the one where the pull would silently destroy the only copy.
export function rescueLocalContent(local, remote) {
  const remoteChapters = remote.chapters ?? [];
  const remoteScenes = new Map();
  for (const chapter of remoteChapters) {
    for (const scene of chapter.scenes ?? []) remoteScenes.set(scene.id, scene);
  }

  const refill = new Map(); // sceneId -> local content, for scenes remote has but empty
  const missing = []; // { chapter, scene } for scenes remote lacks entirely
  for (const chapter of chaptersWithLegacyFallback(local)) {
    for (const scene of chapter.scenes ?? []) {
      if (!hasContent(scene)) continue;
      const remoteScene = remoteScenes.get(scene.id);
      if (!remoteScene) missing.push({ chapter, scene });
      else if (!hasContent(remoteScene)) refill.set(scene.id, scene.content);
    }
  }

  if (refill.size === 0 && missing.length === 0) {
    return { rescued: false, bookData: remote };
  }

  const chapters = remoteChapters.map(chapter => ({
    ...chapter,
    scenes: (chapter.scenes ?? []).map(scene =>
      refill.has(scene.id) ? { ...scene, content: refill.get(scene.id) } : scene
    ),
  }));

  for (const { chapter, scene } of missing) {
    let target = chapters.find(c => c.id === chapter.id);
    if (!target) {
      const { scenes: _scenes, ...chapterMeta } = chapter;
      target = { ...chapterMeta, scenes: [] };
      chapters.push(target);
    }
    target.scenes = [...target.scenes, scene];
  }

  return { rescued: true, bookData: { ...remote, chapters } };
}
