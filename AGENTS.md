# Repository Guidelines

## Project Structure & Module Organization

MetaClaw is a Node 20 TypeScript CLI/TUI project. Source code lives in `src/`, with the entry point at `src/index.ts`. Key areas are organized by responsibility: `src/core/` for orchestration, memory, task, and execution services; `src/storage/` for SQLite repositories and migrations; `src/executor/` for external agent adapters; `src/session/` and `src/tui/` for user interaction; `src/gateway/` and `src/notifications/` for Feishu and delivery integrations; and `src/commands/` for CLI command routing. Tests mirror these domains under `tests/`. Design notes and roadmaps are in `docs/`, while runnable/manual scenarios and fixtures are in `examples/`.

## Build, Test, and Development Commands

- `npm install`: install dependencies from `package-lock.json`.
- `npm run dev`: run `tsup --watch` for incremental builds.
- `npm run build`: bundle `src/index.ts` to `dist/index.js`.
- `npm run start`: run the built CLI from `dist/`.
- `npm test`: run the full Vitest suite once.
- `npm run test:watch`: run Vitest in watch mode.
- `npm run lint`: type-check with `tsc --noEmit`.
- `npm run smoke:metaclaw`: execute the real-task smoke script in `scripts/`.

## Coding Style & Naming Conventions

Use strict TypeScript and ESM imports. Follow the existing style: two-space indentation, single quotes, semicolons, and kebab-case filenames such as `task-runtime-service.ts`. Prefer small, domain-named services and repositories over generic utility modules. Keep React/Ink UI code in `.tsx` files and non-UI logic in `.ts` files.

## Testing Guidelines

Vitest is the test framework, configured for Node with globals enabled. Name tests `*.test.ts` and place them under the matching `tests/<domain>/` folder, for example `tests/core/task-engine.test.ts`. Coverage is configured for `src/core/**` and `src/storage/**`; changes there should include focused regression tests. Run `npm test` and `npm run lint` before submitting.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit prefixes, for example `feat: converge metaclaw session architecture` and `docs: clarify install verification flow`. Use concise imperative subjects with prefixes such as `feat:`, `fix:`, `docs:`, `test:`, or `refactor:`. Pull requests should describe the user-visible change, list validation commands run, link related plans/issues, and include screenshots or terminal output when TUI, CLI, or gateway behavior changes.

## Security & Configuration Tips

Do not commit local credentials, Feishu app secrets, generated databases, or `dist/` artifacts unless explicitly required. Keep environment-specific setup in ignored local files or documented shell steps, and update `README.md` or `docs/` when configuration expectations change.
