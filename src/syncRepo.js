import { detectRepoLayout, migrateLegacyRepo } from './migration.js';
import { pushSync, pullSync } from './sync.js';
import { rescueLocalContent } from './rescue.js';
import { getRef, getCommit, getTree, bootstrapEmptyRepo } from './apiClient.js';

// Higher-level orchestration over pushSync/pullSync: decides whether a repo
// needs bootstrapping (never had a commit), migrating (still on the legacy
// single-.book-file layout), or is ready for a normal push -- and, critically,
// whether this device's *first* sync against an already-populated repo should
// pull that content wholesale rather than feed pushSync a base commit the
// local book was never actually derived from. Feeding pushSync that base
// makes it read every bit of real content as "deleted locally" and wipe it on
// the very next push -- confirmed live during desktop's migration testing. A
// freshly bootstrapped ('empty') repo is excluded from the pull branch
// deliberately: there's nothing real to pull yet, and local's own content is
// what should get pushed there.
export async function syncRepo({ repo, token, branch, bookData, lastSyncCommitSha, cache, author }) {
  const isFirstSyncForThisDevice = !lastSyncCommitSha;
  let baseCommitSha = lastSyncCommitSha;
  const layout = await detectRepoLayout({ repo, token, branch });

  if (layout === 'empty') {
    const bootstrap = await bootstrapEmptyRepo({
      repo,
      token,
      branch,
      path: '_bootstrap.txt',
      content: 'AbsoluteScenes sync bootstrap',
    });
    baseCommitSha = bootstrap.commitSha;
  } else if (layout === 'legacy') {
    // detectRepoLayout only reports the layout kind, not the legacy file's
    // path, so walk the tree to find the single root `.book`-suffixed file
    // before handing it to migrateLegacyRepo.
    const ref = await getRef({ repo, token, branch });
    const commit = await getCommit({ repo, token, sha: ref.sha });
    const tree = await getTree({ repo, token, sha: commit.tree.sha });
    const legacyEntry = tree.find(
      e => !e.path.includes('/') && e.path.endsWith('.book')
    );
    const migration = await migrateLegacyRepo({
      repo,
      token,
      branch,
      legacyFilePath: legacyEntry.path,
      author,
    });
    baseCommitSha = migration.commitSha;
  }

  if (isFirstSyncForThisDevice && (layout === 'legacy' || layout === 'new')) {
    const pulled = await pullSync({ repo, token, branch, cache });
    // Never let the wholesale pull discard local writing the remote doesn't
    // have -- e.g. an old-format .book opened against a repo already
    // hollowed out (empty chapters / empty scene files) by the earlier
    // migration data-loss bug. Fill it back in and push it on top of the
    // pulled tip, so the remote becomes whole again instead of the local.
    const { rescued, bookData: rescuedBook } = rescueLocalContent(bookData, pulled.bookData);
    if (rescued) {
      return pushSync({
        repo,
        token,
        branch,
        bookData: rescuedBook,
        lastSyncCommitSha: pulled.commitSha,
        cache,
        author,
      });
    }
    return { commitSha: pulled.commitSha, bookData: pulled.bookData, conflicts: [] };
  }

  return pushSync({
    repo,
    token,
    branch,
    bookData,
    lastSyncCommitSha: baseCommitSha,
    cache,
    author,
  });
}
