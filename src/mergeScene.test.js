import { mergeSceneContent } from './mergeScene.js';

test('the original question: append at the bottom vs insert in the middle -- no conflict', () => {
  const base = 'Paragraph one.\nParagraph two.\nParagraph three.';
  const local = 'Paragraph one.\nParagraph two.\nParagraph three.\nParagraph four, added by A at the bottom.';
  const remote = 'Paragraph one.\nInserted by B between one and two.\nParagraph two.\nParagraph three.';
  const result = mergeSceneContent(base, local, remote);
  expect(result.conflict).toBe(false);
  expect(result.content).toBe(
    'Paragraph one.\nInserted by B between one and two.\nParagraph two.\nParagraph three.\nParagraph four, added by A at the bottom.'
  );
});

test('true overlapping edit -- both rewrite the same line differently -- produces clean markers', () => {
  const base = 'Paragraph one.\nParagraph two.\nParagraph three.';
  const local = 'Paragraph one.\nParagraph two, rewritten by A.\nParagraph three.';
  const remote = 'Paragraph one.\nParagraph two, rewritten differently by B.\nParagraph three.';
  const result = mergeSceneContent(base, local, remote);
  expect(result.conflict).toBe(true);
  expect(result.content).toContain('<<<<<<<');
  expect(result.content).toContain('Paragraph two, rewritten by A.');
  expect(result.content).toContain('=======');
  expect(result.content).toContain('Paragraph two, rewritten differently by B.');
  expect(result.content).toContain('>>>>>>>');
  // the sentinel must never leak into the caller-visible result, conflict or not
  expect(result.content).not.toContain('<!--LINE-->');
});

test('adjacent dialogue lines with no blank separator, both edited -- merges cleanly thanks to sentinels', () => {
  const base = '"Hello," she said.\n"Hi," he replied.\n"How are you?" she asked.\n"Fine," he said.';
  const local = '"Hello there," she said warmly.\n"Hi," he replied.\n"How are you?" she asked.\n"Fine," he said.';
  const remote = '"Hello," she said.\n"Hi," he replied, distracted.\n"How are you?" she asked.\n"Fine," he said.';
  const result = mergeSceneContent(base, local, remote);
  expect(result.conflict).toBe(false);
  expect(result.content).toBe(
    '"Hello there," she said warmly.\n"Hi," he replied, distracted.\n"How are you?" she asked.\n"Fine," he said.'
  );
});

test('round-trips real paragraph breaks, leading/trailing newlines, and the forced-break marker unaffected by the sentinel scheme', () => {
  const base = '\nLeading blank line.\nTrailing blank line.\n';
  const result = mergeSceneContent(base, base, base);
  expect(result.conflict).toBe(false);
  expect(result.content).toBe(base);

  const withForcedBreak = 'Line with a forced break.\n<!--FORCED_BREAK-->\nAfter the break.';
  const result2 = mergeSceneContent(withForcedBreak, withForcedBreak, withForcedBreak);
  expect(result2.content).toBe(withForcedBreak);
});

test('heavy line repetition does not prevent correct anchoring of edits to unique lines', () => {
  const base = [
    '"Yes," she said.', 'He looked away.', '"Yes," she said.', 'He looked away.',
    '"Are you sure?" he asked.', '"Yes," she said.', 'He looked away.',
    'She stepped through the door.', 'The room was empty.', 'He looked away.',
  ].join('\n');
  const local = base.replace('She stepped through the door.', 'She stepped through the door, hesitating.');
  const remote = base.replace('"Are you sure?" he asked.', '"Are you absolutely sure?" he asked.');
  const result = mergeSceneContent(base, local, remote);
  expect(result.conflict).toBe(false);
  expect(result.content).toContain('She stepped through the door, hesitating.');
  expect(result.content).toContain('"Are you absolutely sure?" he asked.');
});

test('handles an undefined base (e.g. same scene id independently created on both sides) without throwing', () => {
  const result = mergeSceneContent(undefined, 'local content', 'remote content');
  expect(result.conflict).toBe(true);
  expect(result.content).toContain('local content');
  expect(result.content).toContain('remote content');
});

test('no changes on either side returns the base content unchanged, no conflict', () => {
  const result = mergeSceneContent('same content', 'same content', 'same content');
  expect(result).toEqual({ content: 'same content', conflict: false });
});
