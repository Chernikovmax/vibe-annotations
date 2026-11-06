# Repository instructions

## Commit convention

This repository does not use numbered tasks or an issue-tracker ticket key for commits.
The repository-local convention below replaces generic ticket-based commit conventions.

- Write commit messages in English.
- Use the subject `[TAG] Imperative description`, without a trailing period.
- Tags are `[ADD]`, `[MOD]`, `[DEL]`, `[UPDATE]`, `[RELEASE]`, or `[FIX]`; tags may combine.
- Do not prefix subjects with `CC-XXXX` or another task number.
- No `Story:` or task-number trailer is required. Do not invent a ticket or block a commit
  while waiting for one.
- Commit each completed implementation stage separately, after its relevant verification,
  and push that commit before handing the next stage to a fresh Orca session.

## Push destination and limits

- Push explicitly to the user-owned `origin`:
  `https://github.com/Chernikovmax/vibe-annotations.git`.
- `upstream` is the original `RaphaelRegnier/vibe-annotations` repository; do not push there.
- Do not force-push, merge, create another fork, publish packages, or publish a release
  without separate user authorization.
