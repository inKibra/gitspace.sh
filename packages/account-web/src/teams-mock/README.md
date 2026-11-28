# Teams mock

A clickable design mock of GitSpace with people and bots inside one account. It covers account and project roles, the handle,
Needs you, the board, the live pages (People, Projects, Services, Machines, Browsers, Sessions, Usage), Settings for You, a bot
and the team, project settings, machine profiles, approved scripts, secrets and their rules, and machine-hosted MCP servers.

It is design only. All data is invented: the team Crumb & Co, its projects Crumb, Ledger and Field notes, its people Maya,
Theo, Rina, Sam and Jules, and its bots. Nothing calls a server. The striped "MOCK: VIEW AS" strip at the top is the mock's
own control and not product navigation: it switches whose view you see.

Nothing outside this folder imports from it, and the account-web build does not include it. Like the other `mock-*.html`
pages, it is served by the dev server only.

## Run it

```sh
cd packages/account-web
bun run dev
```

Open http://127.0.0.1:4510/mock-teams.html. Every screen has a URL. For example:

- `?as=theo&mode=board` opens the board as Theo.
- `?as=rina&open=bank-feed-sync` opens a workspace.
- `?as=maya&view=settings&page=my-secrets` opens a Settings page.
- `?as=maya&view=project-settings&project=crumb&page=environment` opens a project's settings.

## Retake the screenshots

The scripts in `packages/account-web/scripts/teams-mock/` drive the mock with headless Chromium. Keep the dev server
running, then from `packages/account-web`:

```sh
for script in scripts/teams-mock/shots*.mjs; do
  case $script in *shots-lib.mjs) continue;; esac
  bun "$script" /tmp/teams-mock/shots
done
```

Each script writes PNGs and a captions file into the folder given as its argument, or `TEAMS_MOCK_SHOTS`, or
`/tmp/teams-mock/shots` by default. Set `TEAMS_MOCK_URL` to point at another server. Each script ends by listing any
console errors or warnings the pages logged. Screenshots are not committed.
