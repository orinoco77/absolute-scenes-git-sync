# Running the live integration suite

`live.integration.test.js` runs the exact scenarios manually verified
against a real GitHub repository during this package's design phase
(see `absolute-scenes`'s `docs/superpowers/specs/2026-08-30-git-native-github-sync-design.md`,
section 9). It is skipped automatically unless both env vars are set:

```bash
GIT_SYNC_LIVE_TEST_TOKEN=<fine-grained PAT, Contents: Read and write, scoped to one repo> \
GIT_SYNC_LIVE_TEST_REPO=<owner/repo> \
npm run test:live
```

Each run creates a fresh branch (`live-test-<timestamp>`) so runs don't
collide with each other; branches are not deleted automatically.
