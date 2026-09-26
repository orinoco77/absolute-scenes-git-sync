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

**Switch drafts on one device at a time between syncs.** Switching draft
moves each scene's file between `scenes/…` and `scenes/drafts/<draftId>/…`.
Paths merge independently, so if another device edits a scene at its old
path while this device switches drafts, that edit stays at the old path and
is not carried into the parked draft. It remains in the repository history.
`reconcile.test.js` pins this behaviour.
