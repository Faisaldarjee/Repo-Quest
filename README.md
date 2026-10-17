# RepoQuest

**Duolingo for codebases.**

RepoQuest turns an open-source repository into a playable, verified learning journey. It maps a codebase, proposes hands-on missions, and keeps a mission unpublished until a disposable workspace proves that the task is solvable.

> AI proposes the quest. The sandbox proves it.

## Why RepoQuest?

Joining a new open-source project is often harder than writing the first contribution. A contributor has to guess where requests enter, which service owns the behavior, and how to prove a fix did not break anything.

RepoQuest makes that path explicit:

- **Maintainers** create a shareable `quest.yml` for their repository.
- **Learners** follow a visual quest map instead of reading the whole codebase first.
- **The verifier** runs real commands, tests, and runtime traces in a disposable workspace.
- **The solver check** rejects AI-generated missions that cannot be completed reliably.

## Demo

The included Quest Shop fixture demonstrates:

1. Repository scanning and codebase mapping.
2. A command mission that runs real tests.
3. A trace mission that records the route-to-service execution path.
4. A mutation mission where a bug is injected, reproduced, fixed, and verified.
5. A dark, game-like quest map with locked and unlocked missions.

## Quick start

Requirements:

- Node.js `22.14.0` (see `.nvmrc`)
- npm

```bash
npm ci
npm test
npm run typecheck
npm run dev
```

Open <http://localhost:4000>.

The single offline test command is:

```bash
npm test
```

On Linux, `make test` is also available.

## CLI preview

```bash
npm run repoquest -- scan fixtures/quest-shop
npm run repoquest -- generate fixtures/quest-shop
npm run repoquest -- validate quests/quest-shop.yml
npm run repoquest -- init ./my-repository
npm run repoquest -- play ./my-repository
```

The CLI uses argv-based commands and never interprets mission commands through a shell.

After publishing, the intended maintainer/contributor workflow is:

```bash
npx repoquest init
npx repoquest generate
npx repoquest review
npx repoquest approve . --all
npx repoquest export
npx repoquest play
```

`play` copies the repository into a disposable workspace, starts the local experience on port `4000`, watches file changes, and runs the quest's safe verification commands while you keep using your normal editor.

If port `4000` is already in use, set `PORT` before `play` (`set PORT=4001` on Windows or `PORT=4001 npx repoquest play` on Linux/macOS).

## Public repository preview

The web experience also accepts a clean public GitHub URL. It performs a shallow clone, scans the source without executing it, and builds a community preview. Preview missions are explicitly marked as **not reviewed by the repository maintainer**. Only use this mode for repositories you are allowed to inspect.

The preview limits the clone to 5,000 files and 25 MB of source data, accepts only `https://github.com/owner/repository` URLs, and keeps the clone in a temporary workspace.

## Docker

```bash
docker build -t repoquest .
docker run --rm -p 4000:4000 repoquest
```

Then open <http://localhost:4000>.

## Quest format

Missions are portable YAML. A mission can describe its validation plan without embedding a shell string:

```yaml
schemaVersion: 1
id: my-repository-onboarding
title: My Repository Onboarding
description: Learn this repository by completing verified missions.
missions:
  - id: boot-the-project
    title: Boot the Project
    objective: Run the test suite and confirm the project is healthy.
    validation:
      verifier:
        executable: node
        args: [tests/run-tests.js]
        cwd: .
        timeoutMs: 5000
```

The schema is intentionally small and extensible. Future adapters can add Python, Go, and framework-specific verifiers without changing the learner experience.

## Safety boundaries

RepoQuest is a local-first prototype. The core runner:

- uses argv arrays with `shell: false`;
- allow-lists common development executables;
- rejects absolute or traversal working directories;
- applies timeouts and output limits;
- redacts common secret-shaped output;
- runs each demo attempt in `.repoquest/demo-workspace`; and
- leaves the source fixture untouched.

For untrusted repositories, use a container executor with a read-only filesystem, disabled network, CPU limits, and memory limits. The current demo executor is bounded but is not a replacement for a hardened multi-tenant sandbox.

## Optional AI provider

Mission generation can be connected to an OpenAI-compatible provider through `.env`:

```bash
copy .env.example .env   # Windows
cp .env.example .env     # Linux/macOS
```

Set `AI_BASE_URL`, `AI_API_KEY`, and `AI_MODEL` when using an external provider. The demo and offline tests do not require credentials.

## Project structure

```text
src/core/              portable scanner, manifest, runner, validation engine
src/cli.ts             local RepoQuest CLI preview
src/server.ts          local demo API and static server
public/                quest-map interface
fixtures/quest-shop/   deterministic demo repository
quests/                shareable quest manifests
tests/core/            offline core tests
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The project is intentionally designed around small verifier adapters and portable quest manifests.

## License

MIT. See [LICENSE](LICENSE).
