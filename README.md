# Moben Codex

Follow and steer the Codex tasks on your computer from a Moben e-ink device, by voice: browse your tasks, start new ones, watch a running task, and approve commands and file changes on the device.

> Preview: this needs `@moben-ai/app-sdk` 0.5.0 and Moben device firmware 1.8.5, which are not released yet. The npm package below is not published yet either.

## Requirements

- A Moben device bound to your own Moben account.
- Codex on the computer: the one bundled with the ChatGPT desktop app, or a `codex` command on your PATH. Set `CODEX_BIN` to use another one.
- Node.js 20.12 or later.

## Usage

```sh
npm install -g @moben-ai/codex
moben-codex login     # first time only: approve this computer in the browser
moben-codex           # keep this terminal open; Codex appears in the device's app list
```

Run `moben-codex` once after you start the computer. When you close the terminal or press Ctrl-C, the device shows the app as offline.

Only one copy runs on a computer: starting it again says it is already running. `moben-codex status` shows whether it is running. If you start it on another computer with the same account, the first one disconnects and exits.

## Notes

- The app uses your own Codex configuration (approval policy, sandbox, approval reviewer); the model, reasoning effort and speed can be changed per task on the device. Whoever holds the device can have Codex work on this computer, so keep approvals on.
- Approval requests appear on the device when Codex asks you to approve. If your Codex configuration sends approvals to automatic review instead, they are decided on the computer and the device only shows the result.
- A task that is open in the Codex desktop app can only be continued there; the device says so.
- Settings for new tasks chosen on the device are kept in `~/.moben-codex/`.

## Development

```sh
npm install
npm start                 # runs src/cli.ts with tsx
npx moben app validate    # checks the pages the way the Moben cloud does, without connecting (entry app.ts)
npm run typecheck
npm run build             # bundles dist/cli.js
```

`src/app.ts` defines the Moben app (pages, actions, voice routes), `src/hub.ts` tracks tasks through a private `codex app-server` (`src/codex.ts`), and `src/cli.ts` is the command line. See the [Moben app SDK](https://www.npmjs.com/package/@moben-ai/app-sdk) for the page and voice contract.

## License

MIT
