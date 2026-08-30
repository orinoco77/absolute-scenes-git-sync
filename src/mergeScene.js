import * as Diff3 from 'node-diff3';

const SENTINEL = '<!--LINE-->';

function withSentinels(content) {
  return content.split('\n').join(`\n${SENTINEL}\n`);
}

function stripSentinels(content) {
  return content.split(`\n${SENTINEL}\n`).join('\n');
}

export function mergeSceneContent(base, local, remote) {
  const baseContent = base ?? '';
  const o = withSentinels(baseContent).split('\n');
  const a = withSentinels(local).split('\n');
  const b = withSentinels(remote).split('\n');

  const result = Diff3.merge(a, o, b, { stringSeparator: '\n', excludeFalseConflicts: true });
  const merged = stripSentinels(result.result.join('\n'));

  return { content: merged, conflict: result.conflict };
}
