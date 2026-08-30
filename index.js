// Public API — each export is added by the task that implements it.
export { computeGitBlobSha } from './src/blobSha.js';
export { projectBook, reassembleBook } from './src/project.js';
export { mergeSceneContent } from './src/mergeScene.js';
export { mergeBookMetadata } from './src/mergeMetadata.js';
export {
  getRepo, getRef, updateRef, createRef, createBlob, getBlob,
  createTree, getTree, createCommit, getCommit, compareCommits, bootstrapEmptyRepo,
} from './src/apiClient.js';
export { detectRepoLayout, migrateLegacyRepo } from './src/migration.js';
