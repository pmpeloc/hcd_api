# AGENTS.md

This repository is part of **HCD · Historial Clínico Digital**. All rules are mandatory and live in the `hcd` repo:

- Locally: [`../AGENTS.md`](../AGENTS.md) (this repo must be cloned inside the `hcd` folder).
- Online: https://github.com/pmpeloc/hcd/blob/main/AGENTS.md

Read it before doing anything. In short:
- Code, comments and commit messages in English (Conventional Commits). Only `hcd/docs/` is in Spanish.
- Before every commit, update `../docs/miembros/<member>/bitacora.md` and `estado.md` (member = `git config hcd.member` in `hcd`), then commit and push the `hcd` repo too.
- `main` and `staging` are protected in every repo: work on a branch from `staging` and merge through a PR with 1 approval from another member (nobody is exempt).
- Before starting a task, read `../docs/proyecto/plan.md`, `stack.md`, `decisiones.md` and `../docs/tareas/<member>.md` (your work plan and the files you own).
- Stack: `../docs/proyecto/stack.md`. Package manager: npm.
- No medical data on-chain, not even encrypted.
