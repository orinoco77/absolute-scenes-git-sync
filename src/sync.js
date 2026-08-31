import * as apiClient from './apiClient.js';
import { projectBook, reassembleBook } from './project.js';
import { computeGitBlobSha } from './blobSha.js';
import { mergeSceneContent } from './mergeScene.js';
import { mergeBookMetadata } from './mergeMetadata.js';

async function fetchRemoteFile({ repo, token, remoteTreeByPath, path }) {
  const entry = remoteTreeByPath.get(path);
  if (!entry) return null;
  const blob = await apiClient.getBlob({ repo, token, sha: entry.sha });
  // GitHub's blob API always reports encoding:'base64' regardless of how the
  // blob was created, so encoding-sniffing is useless here -- decide text vs.
  // binary from the path itself, same convention pullSync (Task 9) uses.
  const isText = path === 'book.json' || path.endsWith('.md');
  return isText
    ? { content: atob_utf8(blob.content), encoding: 'utf-8' }
    : { content: blob.content, encoding: 'base64' };
}

// GitHub's blob API always returns base64-encoded content regardless of the
// original encoding at write time -- decode to a utf-8 string for text files.
function atob_utf8(base64) {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function buildAttempt({ repo, token, bookData, baseTreeSha, remoteTreeSha, cache }) {
  const localFiles = projectBook(bookData);
  // Defensive filter to blob entries, mirroring pullSync's own guard below --
  // GitHub's real recursive tree listing includes directory entries (type:
  // 'tree') that getTree is expected to strip, but buildAttempt must not
  // trust that unconditionally: an unfiltered directory path (e.g. 'scenes')
  // reads as "a file the local projection no longer has" and gets scheduled
  // for deletion, wiping everything under it. Verified live -- a real,
  // confirmed data-loss bug, not a hypothetical.
  const remoteTree = (await apiClient.getTree({ repo, token, sha: remoteTreeSha })).filter(e => e.type === 'blob');
  const remoteTreeByPath = new Map(remoteTree.map(e => [e.path, e]));

  const baseTree = baseTreeSha ? (await apiClient.getTree({ repo, token, sha: baseTreeSha })).filter(e => e.type === 'blob') : [];
  const baseTreeByPath = new Map(baseTree.map(e => [e.path, e]));

  const entries = [];
  const conflicts = [];
  const mergedFiles = new Map();

  for (const [path, local] of localFiles) {
    const localSha = await computeGitBlobSha(local.content, local.encoding);
    const remoteEntry = remoteTreeByPath.get(path);
    const baseEntry = baseTreeByPath.get(path);

    const remoteChanged = remoteEntry?.sha !== baseEntry?.sha;
    const localChanged = localSha !== baseEntry?.sha;

    if (!localChanged && !remoteChanged) {
      mergedFiles.set(path, local); // identical everywhere, nothing to do
      continue;
    }
    if (!localChanged && remoteChanged) {
      // Only remote changed this path -- adopt remote's content. Without
      // this branch, "local" here is just stale base content, and setting
      // it would silently revert remote's change and push a commit doing
      // so -- a real, confirmed data-loss bug caught in final review.
      const remoteFile = await fetchRemoteFile({ repo, token, remoteTreeByPath, path });
      mergedFiles.set(path, remoteFile ?? local);
      continue;
    }
    if (localChanged && !remoteChanged) {
      mergedFiles.set(path, local);
      continue;
    }

    // both changed -- merge
    if (path.startsWith('scenes/')) {
      const remoteFile = await fetchRemoteFile({ repo, token, remoteTreeByPath, path });
      const baseFile = baseEntry ? await apiClient.getBlob({ repo, token, sha: baseEntry.sha }).then(b => atob_utf8(b.content)) : undefined;
      const { content, conflict } = mergeSceneContent(baseFile, local.content, remoteFile?.content ?? '');
      mergedFiles.set(path, { content, encoding: 'utf-8' });
      if (conflict) conflicts.push({ sceneId: path.replace('scenes/', '').replace('.md', '') });
    } else if (path === 'book.json') {
      const remoteFile = await fetchRemoteFile({ repo, token, remoteTreeByPath, path });
      const baseJson = baseEntry ? JSON.parse(await apiClient.getBlob({ repo, token, sha: baseEntry.sha }).then(b => atob_utf8(b.content))) : {};
      const localJson = JSON.parse(local.content);
      const remoteJson = JSON.parse(remoteFile.content);
      const merged = mergeBookMetadata(baseJson, localJson, remoteJson, 'local');
      mergedFiles.set(path, { content: JSON.stringify(merged, null, 2), encoding: 'utf-8' });
    } else {
      // illustrations and anything else binary: last-write-wins, remote wins
      // on a true concurrent edit since we have no way to merge binary content.
      const remoteFile = await fetchRemoteFile({ repo, token, remoteTreeByPath, path });
      mergedFiles.set(path, remoteFile ?? local);
    }
  }

  // paths that exist on remote but not in local's projection at all -> deleted locally
  for (const path of remoteTreeByPath.keys()) {
    if (!localFiles.has(path) && baseTreeByPath.has(path)) {
      entries.push({ path, mode: '100644', type: 'blob', sha: null });
    }
  }

  for (const [path, file] of mergedFiles) {
    const sha = await computeGitBlobSha(file.content, file.encoding);
    const remoteEntry = remoteTreeByPath.get(path);
    if (remoteEntry?.sha === sha) continue; // identical to what's already on remote, skip

    let cached = await cache.get(path);
    if (!cached || cached.sha !== sha) {
      const { sha: createdSha } = await apiClient.createBlob({ repo, token, content: file.content, encoding: file.encoding });
      cached = { sha: createdSha, content: file.content, encoding: file.encoding };
      await cache.set(path, cached);
    }
    entries.push({ path, mode: '100644', type: 'blob', sha: cached.sha });
  }

  const mergedBookData = reassembleBook(mergedFiles);
  return { entries, conflicts, mergedBookData };
}

export async function pushSync({ repo, token, branch, bookData, lastSyncCommitSha, cache, author, maxRetries = 5 }) {
  let currentLastSync = lastSyncCommitSha;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Fetch the branch tip exactly once per attempt and reuse it for both the
    // compare-base lookup and the commit fetch below -- calling getRef twice
    // per attempt would let the remote tip observed by compareCommits drift
    // from the one used to build the new commit's parent/tree.
    const remoteRef = await apiClient.getRef({ repo, token, branch });
    const compare = currentLastSync
      ? await apiClient.compareCommits({ repo, token, base: currentLastSync, head: remoteRef.sha })
      : null;

    const remoteCommit = await apiClient.getCommit({ repo, token, sha: remoteRef.sha });
    const baseCommitSha = compare?.mergeBaseSha ?? null;
    const baseTreeSha = baseCommitSha ? (await apiClient.getCommit({ repo, token, sha: baseCommitSha })).tree.sha : null;

    const { entries, conflicts, mergedBookData } = await buildAttempt({
      repo, token, bookData, baseTreeSha, remoteTreeSha: remoteCommit.tree.sha, cache,
    });

    if (entries.length === 0) {
      return { commitSha: remoteRef.sha, bookData: mergedBookData, conflicts };
    }

    const newTree = await apiClient.createTree({ repo, token, baseTree: remoteCommit.tree.sha, entries });
    const newCommit = await apiClient.createCommit({
      repo, token,
      message: conflicts.length > 0 ? 'Sync with unresolved conflicts' : 'Sync',
      tree: newTree.sha,
      parents: [remoteRef.sha],
      author,
    });

    const updateResult = await apiClient.updateRef({ repo, token, branch, sha: newCommit.sha, force: false });
    if (updateResult.ok) {
      return { commitSha: newCommit.sha, bookData: mergedBookData, conflicts };
    }

    // 422: someone else pushed in the gap. Retry from the top with the
    // remote's new tip as the reference point for the next attempt.
    // lastSyncCommitSha is still our real last-known-good sync point, so
    // currentLastSync is intentionally left unchanged here.
  }

  throw new Error(`Could not sync after ${maxRetries} attempts -- repeated concurrent pushes from another device.`);
}

export async function pullSync({ repo, token, branch, cache }) {
  const ref = await apiClient.getRef({ repo, token, branch });
  const commit = await apiClient.getCommit({ repo, token, sha: ref.sha });
  const tree = await apiClient.getTree({ repo, token, sha: commit.tree.sha });

  const files = new Map();
  for (const entry of tree) {
    if (entry.type !== 'blob') continue;
    const cached = await cache.get(entry.path);
    if (cached && cached.sha === entry.sha) {
      files.set(entry.path, { content: cached.content, encoding: cached.encoding });
      continue;
    }
    const blob = await apiClient.getBlob({ repo, token, sha: entry.sha });
    // Same path-based text/binary convention as fetchRemoteFile above --
    // GitHub's blob API always reports encoding:'base64' regardless of the
    // file's real nature, so encoding-sniffing is useless here too.
    const isText = entry.path === 'book.json' || entry.path.endsWith('.md');
    const content = isText ? atob_utf8(blob.content) : blob.content;
    const encoding = isText ? 'utf-8' : 'base64';
    files.set(entry.path, { content, encoding });
    await cache.set(entry.path, { sha: entry.sha, content, encoding });
  }

  return { commitSha: ref.sha, bookData: reassembleBook(files) };
}
