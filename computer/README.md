# Computer Status

A Moben remote app showing the configuration and live status of the computer it runs on. Pages support English and Chinese.

## Run

From the repository root:

```sh
cd computer
npm install
npx moben login
npm start
```

Requires Node.js 20.12 or later. After the log shows `online`, open Computer Status on your Moben device. Login credentials are shared by all Moben apps on this computer.

For servers and CI, set `MOBEN_DEVELOPER_KEY` in the environment or copy `.env.example` to `.env` in this directory and set it there. Never commit the key.

## Local checks

Run from `computer/` without connecting to the cloud:

```sh
npm run check
npx moben app tool get_computer_status
npx moben app page / --locale en --timezone Asia/Shanghai
npx moben app page / --locale zh-CN --timezone Asia/Shanghai
```

`npm run dev` restarts the app when files change. Local dependencies, `.env` and `.runtime/` stay inside `computer/` and are ignored by Git.
