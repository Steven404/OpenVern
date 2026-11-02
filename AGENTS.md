# Agent rules for this repo

Read this before taking any action in this project.

## Local-only folders: never commit

- `reports/` and `research_notes/` are local-only. They must never be added to git.
- Do not `git add` them, do not force-add (`git add -f`) anything under them, and do not
  remove their entries from `.gitignore`.
- Avoid broad staging that could sweep them in. Stage files by path rather than with
  `git add -A` / `git add .` when unsure.
- Before committing, check `git status` and confirm nothing under these folders is staged.
