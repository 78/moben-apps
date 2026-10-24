# Moben Codex

Follow and steer the Codex tasks on your computer from a Moben e-ink device, by voice: browse your tasks, start new ones, watch a running task, and approve commands and file changes on the device.

> Voice capture and streamed task pages need Moben device firmware 1.8.5 or later.

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
- On device app protocol 3, the footer follows app-server events: reasoning → Thinking, active commands/tools → Executing, approval → Approval, user input → Your input. Unknown phases use Waiting. Approval/input flags take priority; parallel work stays active until its last item completes. Reopening a page preserves current evidence, late events and stale snapshots cannot overwrite newer work, and completion/disconnection clear it. The task body has no fixed working line. Older devices keep the content without this status.
- Settings for new tasks chosen on the device are kept in `~/.moben-codex/`. Model, reasoning effort and speed menus focus the current choice when opened on firmware with Action Sheet selection support.

## Development

This app lives in `codex/` in the Moben Apps repository. From the repository root:

```sh
cd codex
npm install
npm start                 # runs src/cli.ts with tsx
npm run check            # validates pages locally through tsx (entry app.ts)
npm run typecheck
npm run build             # bundles dist/cli.js
```

`src/app.ts` defines the Moben app (pages, actions, voice routes), `src/hub.ts` tracks tasks through a private `codex app-server` (`src/codex.ts`), and `src/cli.ts` is the command line. `src/activity.ts` reduces upstream thread/item events into the current temporary status; it never infers reasoning from elapsed time or stores reasoning text. See the [Moben app SDK](https://www.npmjs.com/package/@moben-ai/app-sdk) for the page and voice contract.

Run all development commands from `codex/`. Dependencies and build output stay in this directory; user settings remain in `~/.moben-codex/`. The npm package name and `moben-codex` command are unchanged.

`npm run check` loads the SDK validator through `tsx` so extensionless TypeScript imports work on Node.js 20 and 22. To inspect a specific page, use `npx tsx node_modules/@moben-ai/app-sdk/dist/cli.js app page / --locale zh-CN`.

## License

MIT
