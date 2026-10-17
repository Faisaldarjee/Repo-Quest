# Contributing to RepoQuest

Thanks for helping make codebases easier to learn.

## Development loop

```bash
npm ci
npm test
npm run typecheck
npm run dev
```

Keep changes focused. Add a test for new core behavior, keep paths portable, and do not commit credentials or generated `.repoquest` workspaces.

## Adding a verifier

1. Define a safe, structured command or verifier result.
2. Reject invalid paths and unsupported executables before execution.
3. Run it against a disposable workspace.
4. Add a deterministic test for pass, fail, timeout, and traversal behavior.
5. Document the quest manifest shape.

## Pull requests

- Explain the learner or maintainer outcome.
- Include the exact checks you ran.
- Keep `package-lock.json` in sync when dependencies change.
- Do not add absolute paths or secrets.
