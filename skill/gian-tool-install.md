# Install the Gian Tool skill

The Gian Tool skill stays in the Gian repository. There is no separate skill
repository. Packaging reads `packages/tool-cli/skill/gian-tool/` and this
guide.

```sh
node scripts/package-gian-tool-skill.mjs <output-directory>
```

The output directory is the installed skill. It contains `SKILL.md`, this
guide as `INSTALL.md`, `scripts/gianctl`, `scripts/gian-tool-mcp`, and
`skill-manifest.json`. The manifest sets `mcpConfigured` to false and records
a SHA-256 for each copied file. Give that directory to the agent that should
call Gian. The helpers run from an installed Gian.app and do not need a
developer checkout.

Packaging copies those files. It leaves MCP client configuration, Gian
settings, and the running app unchanged. Installing the skill does not configure MCP.

## Skill-local helpers

Run `scripts/gianctl` and `scripts/gian-tool-mcp` from the skill directory.
They are skill-local programs. Packaging does not put them on `PATH`.

Both helpers read `GIAN_APP_PATH`. When that variable is unset, they use
`/Applications/Gian.app`.

They execute the app bundle's Node and the unpacked CLI entry:

- Node: `$GIAN_APP_PATH/Contents/Resources/runtime/node`
- `scripts/gianctl`: `$GIAN_APP_PATH/Contents/Resources/app.asar.unpacked/node_modules/@gian/tool-cli/dist/cli.js`
- `scripts/gian-tool-mcp`: `$GIAN_APP_PATH/Contents/Resources/app.asar.unpacked/node_modules/@gian/tool-mcp/dist/cli.js`

Each helper forwards its arguments and stdio to that entry. When the bundled
Node runtime or CLI entry is missing, the helper writes an English message to
stderr and exits. It does not start Gian, write configuration, or create a
credential.

`scripts/gianctl` accepts `ping`, `schema`, `call`, and `wait`. Override the
data directory with `--data-dir` or `GIAN_DATA_DIR`. The default data
directory is `~/.gian`.

`scripts/gian-tool-mcp` accepts `--data-dir` or `GIAN_DATA_DIR` and rejects
any other argument. An MCP client starts this process and speaks MCP on its
stdio.

## How the external tool reaches Gian

While Gian is running, Host listens on the Unix socket
`<data-dir>/run/gian-tool-v1.sock`. Both helpers use that socket. This is the
external controller. The client starts `scripts/gian-tool-mcp` against the
Host that is already running, so the MCP adapter does not need a separate
daemon distribution.

The same Host serves authenticated loopback HTTP at
`http://127.0.0.1:8990/internal/mcp`. No production command issues an
external credential for that HTTP endpoint. Leave the Host database unread.
The external helpers stay on the Unix socket and on stdio.

## Managed Session credentials are separate

For a supported managed Session, Gian injects that Session's MCP descriptor
and credentials at Session start and resume. Those credentials are not
written into the Agent Home. Copying the managed Skill onto disk is a
separate placement, and it is not done for every Provider. `gian-tool` does
not use those Session credentials.
