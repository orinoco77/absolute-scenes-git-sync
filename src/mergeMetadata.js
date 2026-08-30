function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function mergeSimpleField(base, local, remote, tieBreak) {
  const localChanged = !deepEqual(base, local);
  const remoteChanged = !deepEqual(base, remote);
  if (!localChanged && !remoteChanged) return base;
  if (localChanged && !remoteChanged) return local;
  if (!localChanged && remoteChanged) return remote;
  if (deepEqual(local, remote)) return local;
  return tieBreak === 'local' ? local : remote;
}

function mergeStringSetField(base, local, remote) {
  return [...new Set([...(local ?? []), ...(remote ?? [])])];
}

function mergeArrayWithIds(base, local, remote, tieBreak, mergeItem) {
  const baseById = new Map((base ?? []).map(item => [item.id, item]));
  const localById = new Map((local ?? []).map(item => [item.id, item]));
  const remoteById = new Map((remote ?? []).map(item => [item.id, item]));
  const allIds = new Set([...baseById.keys(), ...localById.keys(), ...remoteById.keys()]);

  const result = [];
  for (const id of allIds) {
    const baseItem = baseById.get(id);
    const localItem = localById.get(id);
    const remoteItem = remoteById.get(id);

    if (!baseItem) {
      // New item -- added by local, remote, or (identically) both.
      if (localItem) result.push(localItem);
      else if (remoteItem) result.push(remoteItem);
      continue;
    }

    const localDeleted = !localItem;
    const remoteDeleted = !remoteItem;
    const localChanged = localItem && !deepEqual(baseItem, localItem);
    const remoteChanged = remoteItem && !deepEqual(baseItem, remoteItem);

    if (localDeleted && remoteDeleted) continue; // deleted by both
    if (localDeleted && !remoteChanged) continue; // deleted by local, remote never touched it
    if (remoteDeleted && !localChanged) continue; // deleted by remote, local never touched it
    if (localDeleted && remoteChanged) { result.push(remoteItem); continue; } // deletion loses to an edit
    if (remoteDeleted && localChanged) { result.push(localItem); continue; }

    // present on both sides -- merge the item itself
    result.push(mergeItem(baseItem, localItem, remoteItem, tieBreak));
  }
  return result;
}

function mergeSceneMeta(base, local, remote, tieBreak) {
  return {
    id: base.id,
    title: mergeSimpleField(base.title, local.title, remote.title, tieBreak),
    notes: mergeSimpleField(base.notes, local.notes, remote.notes, tieBreak),
    created: mergeSimpleField(base.created, local.created, remote.created, tieBreak),
    modified: mergeSimpleField(base.modified, local.modified, remote.modified, tieBreak),
    assignedAuthor: mergeSimpleField(base.assignedAuthor, local.assignedAuthor, remote.assignedAuthor, tieBreak),
  };
}

function mergeChapter(base, local, remote, tieBreak) {
  return {
    id: base.id,
    title: mergeSimpleField(base.title, local.title, remote.title, tieBreak),
    scenes: mergeArrayWithIds(base.scenes, local.scenes, remote.scenes, tieBreak, mergeSceneMeta),
  };
}

function mergeSimpleItem(base, local, remote, tieBreak) {
  // Generic id-keyed item with no nested array of its own (characters,
  // locations, parts, frontMatter, backMatter, backgroundFolders' shallow
  // fields) -- field-by-field last-write-wins on conflict.
  const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
  const merged = {};
  for (const key of keys) {
    merged[key] = mergeSimpleField(base[key], local[key], remote[key], tieBreak);
  }
  return merged;
}

export function mergeBookMetadata(base, local, remote, tieBreak) {
  return {
    title: mergeSimpleField(base.title, local.title, remote.title, tieBreak),
    author: mergeSimpleField(base.author, local.author, remote.author, tieBreak),
    template: mergeSimpleField(base.template, local.template, remote.template, tieBreak),
    collaboration: mergeSimpleField(base.collaboration, local.collaboration, remote.collaboration, tieBreak),
    metadata: mergeSimpleField(base.metadata, local.metadata, remote.metadata, tieBreak),
    characterDetectionBlacklist: mergeStringSetField(
      base.characterDetectionBlacklist,
      local.characterDetectionBlacklist,
      remote.characterDetectionBlacklist
    ),
    chapters: mergeArrayWithIds(base.chapters, local.chapters, remote.chapters, tieBreak, mergeChapter),
    characters: mergeArrayWithIds(base.characters, local.characters, remote.characters, tieBreak, mergeSimpleItem),
    locations: mergeArrayWithIds(base.locations, local.locations, remote.locations, tieBreak, mergeSimpleItem),
    parts: mergeArrayWithIds(base.parts, local.parts, remote.parts, tieBreak, mergeSimpleItem),
    frontMatter: mergeArrayWithIds(base.frontMatter, local.frontMatter, remote.frontMatter, tieBreak, mergeSimpleItem),
    backMatter: mergeArrayWithIds(base.backMatter, local.backMatter, remote.backMatter, tieBreak, mergeSimpleItem),
    backgroundFolders: mergeArrayWithIds(base.backgroundFolders, local.backgroundFolders, remote.backgroundFolders, tieBreak, mergeSimpleItem),
    illustrations: mergeArrayWithIds(base.illustrations, local.illustrations, remote.illustrations, tieBreak, mergeSimpleItem),
  };
}
