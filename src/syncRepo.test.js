import { jest } from '@jest/globals';

jest.unstable_mockModule('./migration.js', () => ({
  detectRepoLayout: jest.fn(),
  migrateLegacyRepo: jest.fn(),
}));
jest.unstable_mockModule('./sync.js', () => ({
  pushSync: jest.fn(),
  pullSync: jest.fn(),
}));
jest.unstable_mockModule('./apiClient.js', () => ({
  getRef: jest.fn(),
  getCommit: jest.fn(),
  getTree: jest.fn(),
  bootstrapEmptyRepo: jest.fn(),
}));

const { syncRepo } = await import('./syncRepo.js');
const migration = await import('./migration.js');
const sync = await import('./sync.js');
const apiClient = await import('./apiClient.js');

afterEach(() => jest.resetAllMocks());

function baseArgs(overrides = {}) {
  return {
    repo: 'owner/repo',
    token: 't',
    branch: 'main',
    bookData: { title: 'T' },
    lastSyncCommitSha: 'sync-sha',
    cache: { get: jest.fn(), set: jest.fn() },
    author: { name: 'Alice', email: 'alice@example.com' },
    ...overrides,
  };
}

test('an already-new-layout repo skips migration and calls pushSync directly', async () => {
  migration.detectRepoLayout.mockResolvedValue('new');
  sync.pushSync.mockResolvedValue({ commitSha: 'new-sha', bookData: { title: 'T' }, conflicts: [] });

  const result = await syncRepo(baseArgs());

  expect(migration.migrateLegacyRepo).not.toHaveBeenCalled();
  expect(sync.pushSync).toHaveBeenCalledWith(
    expect.objectContaining({ repo: 'owner/repo', branch: 'main', lastSyncCommitSha: 'sync-sha' })
  );
  expect(result.conflicts).toEqual([]);
});

test('a legacy-layout repo is migrated before the first pushSync call', async () => {
  migration.detectRepoLayout.mockResolvedValue('legacy');
  apiClient.getRef.mockResolvedValue({ sha: 'ref-sha' });
  apiClient.getCommit.mockResolvedValue({ tree: { sha: 'tree-sha' } });
  apiClient.getTree.mockResolvedValue([{ path: 'Book.book' }, { path: 'nested/other.book' }]);
  migration.migrateLegacyRepo.mockResolvedValue({ commitSha: 'migration-sha' });
  sync.pushSync.mockResolvedValue({ commitSha: 'new-sha', bookData: { title: 'T' }, conflicts: [] });

  await syncRepo(baseArgs());

  expect(migration.migrateLegacyRepo).toHaveBeenCalledWith(
    expect.objectContaining({ legacyFilePath: 'Book.book' })
  );
  const pushCall = sync.pushSync.mock.calls[0][0];
  expect(pushCall.lastSyncCommitSha).toBe('migration-sha');
});

test('no prior lastSyncCommitSha against a legacy repo pulls the migrated content instead of pushing a merge', async () => {
  migration.detectRepoLayout.mockResolvedValue('legacy');
  apiClient.getRef.mockResolvedValue({ sha: 'ref-sha' });
  apiClient.getCommit.mockResolvedValue({ tree: { sha: 'tree-sha' } });
  apiClient.getTree.mockResolvedValue([{ path: 'Book.book' }]);
  migration.migrateLegacyRepo.mockResolvedValue({ commitSha: 'migration-sha' });
  sync.pullSync.mockResolvedValue({
    commitSha: 'migration-sha',
    bookData: { title: 'Migrated Book', chapters: [{ id: 'ch1', scenes: [{ id: 'sc1' }] }] },
  });

  const result = await syncRepo(baseArgs({ lastSyncCommitSha: undefined }));

  expect(sync.pushSync).not.toHaveBeenCalled();
  expect(sync.pullSync).toHaveBeenCalled();
  expect(result.bookData.title).toBe('Migrated Book');
  expect(result.commitSha).toBe('migration-sha');
  expect(result.conflicts).toEqual([]);
});

test('no prior lastSyncCommitSha against an already-populated new-layout repo pulls instead of pushing', async () => {
  migration.detectRepoLayout.mockResolvedValue('new');
  sync.pullSync.mockResolvedValue({ commitSha: 'existing-tip-sha', bookData: { title: 'Existing Repo Book', chapters: [] } });

  const result = await syncRepo(baseArgs({ lastSyncCommitSha: undefined }));

  expect(sync.pushSync).not.toHaveBeenCalled();
  expect(sync.pullSync).toHaveBeenCalled();
  expect(result.bookData.title).toBe('Existing Repo Book');
  expect(result.commitSha).toBe('existing-tip-sha');
});

test('no prior lastSyncCommitSha against a freshly bootstrapped (empty) repo still pushes -- nothing real to pull yet', async () => {
  migration.detectRepoLayout.mockResolvedValue('empty');
  apiClient.bootstrapEmptyRepo.mockResolvedValue({ commitSha: 'bootstrap-sha' });
  sync.pushSync.mockResolvedValue({ commitSha: 'new-sha', bookData: { title: 'T' }, conflicts: [] });

  await syncRepo(baseArgs({ lastSyncCommitSha: undefined }));

  expect(sync.pullSync).not.toHaveBeenCalled();
  const pushCall = sync.pushSync.mock.calls[0][0];
  expect(pushCall.lastSyncCommitSha).toBe('bootstrap-sha');
});

test('an empty repo is bootstrapped, then migration is skipped (nothing to migrate), then pushed', async () => {
  migration.detectRepoLayout.mockResolvedValue('empty');
  apiClient.bootstrapEmptyRepo.mockResolvedValue({ commitSha: 'bootstrap-sha' });
  sync.pushSync.mockResolvedValue({ commitSha: 'new-sha', bookData: { title: 'T' }, conflicts: [] });

  await syncRepo(baseArgs());

  expect(apiClient.bootstrapEmptyRepo).toHaveBeenCalled();
  expect(migration.migrateLegacyRepo).not.toHaveBeenCalled();
});
