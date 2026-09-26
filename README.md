# @absolute-scenes/git-sync

Syncs an Absolute Scenes `.book` with a GitHub repository, storing it as
per-file Markdown so edits on different devices merge three-way.

## Repository layout

| Path | Contents |
| --- | --- |
| `book.json` | Everything except scene text and illustration images |
| `scenes/<sceneId>.md` | Active draft, active revision text |
| `scenes/<sceneId>.rev-<revId>.md` | Active draft, inactive revision text |
| `scenes/drafts/<draftId>/<sceneId>.md` | Inactive draft, active revision text |
| `scenes/drafts/<draftId>/<sceneId>.rev-<revId>.md` | Inactive draft, inactive revision text |
| `illustrations/<id>.<ext>` | Illustration images |

Books without drafts or revisions produce only `book.json`, `scenes/<id>.md`
and `illustrations/…`, exactly as before.

## Known limitations

Files merge by path, but switching a draft or revision changes which text
lives at which path. Until merging is made draft/revision-aware, **switch
drafts or revisions on one device at a time, and sync before switching on
another device.** Each case below is pinned by a test in `reconcile.test.js`.

- **Revision switch + concurrent edit to the old revision:** the edit is
  three-way merged into the *newly active* revision without any conflict
  being reported. The revision that was actually edited stays unchanged.
- **Draft switch + concurrent edit to a scene in the old draft:** the edit
  stays at the old path. It is not carried into the parked draft, but it
  remains in the repository history.
- **Two devices switch to different drafts:** one side's `activeDraft` wins.
  The other draft's chapters are mixed into the active draft, and that draft
  disappears from the draft list. No text is lost, but the structure has to
  be sorted out by hand.
