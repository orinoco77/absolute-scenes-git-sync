import { projectBook, reassembleBook } from './project.js';
import { mergeSceneContent } from './mergeScene.js';
import { mergeBookMetadata } from './mergeMetadata.js';

function filesEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.content === b.content && a.encoding === b.encoding;
}

// A sync's round-trip is not instant -- it can take several seconds. Treating
// sync completion as an unconditional replace silently discards any edit made
// on this device while the round-trip was still in flight, with nothing
// pushed to GitHub to recover it from (confirmed live during desktop's own
// sync rework). This reconciles the sync's result against whatever actually
// happened on this device in the meantime, using the exact same 3-way-merge
// shape pushSync's buildAttempt already uses for local-vs-remote -- just run
// once more, purely in memory, with "the edit made while the sync was
// running" standing in for "local" and "the sync's own result" standing in
// for "remote". `base` is the book snapshot the sync started from; `local` is
// the caller's current in-memory state as of the moment the sync resolved;
// `remote` is the sync's own result.
export function reconcilePostSyncState(base, local, remote) {
  if (local === base) {
    // Nothing changed on this device while the sync was in flight -- fast
    // path, skip the merge machinery entirely.
    return { bookData: remote, conflicts: [] };
  }

  const baseFiles = projectBook(base);
  const localFiles = projectBook(local);
  const remoteFiles = projectBook(remote);
  const allPaths = new Set([
    ...baseFiles.keys(),
    ...localFiles.keys(),
    ...remoteFiles.keys()
  ]);

  const merged = new Map();
  const conflicts = [];

  for (const path of allPaths) {
    const b = baseFiles.get(path);
    const l = localFiles.get(path);
    const r = remoteFiles.get(path);

    const localChanged = !filesEqual(b, l);
    const remoteChanged = !filesEqual(b, r);

    if (!localChanged && !remoteChanged) {
      if (r ?? b) merged.set(path, r ?? b);
      continue;
    }
    if (!localChanged && remoteChanged) {
      // Local never touched this path -- adopt the sync's own result.
      if (r) merged.set(path, r);
      continue;
    }
    if (localChanged && !remoteChanged) {
      // The sync's result didn't touch this path -- keep the in-flight
      // local edit, including a local deletion (l undefined).
      if (l) merged.set(path, l);
      continue;
    }

    // Both sides changed this path since the pre-sync snapshot -- a
    // genuine same-device race on the same file.
    if (!l && !r) continue; // deleted on both sides
    if (!l) {
      // Deleted locally during the flight, but the sync's result still
      // changed it -- keep the sync's edit rather than lose it to a race.
      merged.set(path, r);
      continue;
    }
    if (!r) {
      // The sync's result deleted this path, but the in-flight local edit
      // is more recent -- never silently drop a live edit just made.
      merged.set(path, l);
      continue;
    }

    if (path === 'book.json') {
      const bookMerged = mergeBookMetadata(
        JSON.parse(b.content),
        JSON.parse(l.content),
        JSON.parse(r.content),
        'local'
      );
      merged.set(path, {
        content: JSON.stringify(bookMerged, null, 2),
        encoding: 'utf-8'
      });
    } else if (path.startsWith('scenes/')) {
      const { content, conflict } = mergeSceneContent(
        b?.content,
        l.content,
        r.content
      );
      merged.set(path, { content, encoding: 'utf-8' });
      if (conflict) {
        conflicts.push({
          sceneId: path.replace('scenes/', '').replace('.md', '')
        });
      }
    } else {
      // Illustrations and anything else binary: no merge strategy exists,
      // so prefer the in-flight local edit -- it's the user's own, more
      // recent action on this device, not a stranger's concurrent edit.
      merged.set(path, l);
    }
  }

  const bookData = { ...reassembleBook(merged), github: remote.github };
  return { bookData, conflicts };
}
