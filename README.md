# Moben Apps

Moben remote apps that run on your computer and appear on your Moben device.

| Directory | App | Package |
| --- | --- | --- |
| [computer/](computer/) | Computer Status: computer configuration and live status | Private example |
| [codex/](codex/) | Follow and steer Codex tasks by voice | `@moben-ai/codex` |

Each app has its own dependencies, lockfile and startup command. There is no installation or startup command at the repository root.

## Development

Install Node.js 20.12 or later, then choose an app:

```sh
cd computer  # or: cd codex
npm install
npx moben login  # once per computer; shared by both apps
npm start
```

Run each app in its own terminal to use both at once. See [Computer Status](computer/README.md) and [Moben Codex](codex/README.md) for validation and other commands.

Keep app-specific `.env` files inside their app directory. Never commit developer keys. Computer Status reads `computer/.env`; Moben Codex accepts `MOBEN_DEVELOPER_KEY` from its process environment. Normal desktop use shares the credentials saved by `moben login`. Codex settings remain in `~/.moben-codex/`.

## Repository history

Computer Status was moved from the repository root to `computer/`. Moben Codex was imported into `codex/` with its original commits preserved through a Git subtree merge. Both apps are maintained in this repository; neither directory is a nested Git repository. Codex package metadata still links to its existing public repository.

Shared app development rules are in [AGENTS.md](AGENTS.md).
