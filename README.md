# pi-shell-reminder

A small [Pi](https://pi.dev/) extension that reminds you when Pi was started outside the local development shell for the current project.

It detects common project-local shells while walking upward from the current working directory:

- [Devbox](https://www.jetify.com/devbox/) via `devbox.json`
- [devenv](https://devenv.sh/) via `devenv.nix` or `devenv.yaml`
- Nix shells via `shell.nix`, `flake.nix` dev shells, or `default.nix` with `mkShell`
- [direnv](https://direnv.net/) via `.envrc`

When a shell is detected but not active, the extension sets a footer status and shows a startup warning with the command to run.

## Install

From git:

```sh
pi install git:github.com:ohare93/pi-shell-reminder
```

For local development:

```sh
pi -e /home/jmo/Development/projects/pi-shell-reminder
```

Or add it to Pi settings:

```json
{
  "packages": [
    "/home/jmo/Development/projects/pi-shell-reminder"
  ]
}
```

## Usage

The extension checks the current project on Pi startup and reload.

It also registers a command:

```text
/shell-check
```

Use `/shell-check` to manually re-run detection for the current working directory.

## Behavior

If a supported shell configuration is found and the matching shell appears active, the extension stays quiet.

If a supported shell configuration is found and no matching shell appears active, it warns with guidance such as:

```text
Devbox shell detected at ~/project/devbox.json, but Pi was started outside it.
Exit Pi, run `devbox shell` from ~/project, then start Pi again.
```

If multiple shell systems are detected in the same directory, the extension prefers them in this order:

1. Devbox
2. devenv
3. Nix dev shell
4. direnv

Alternative shell commands from the same directory are included in the warning.

## Development

```sh
npm install
npm run typecheck
pi -e ./
```

## Package manifest

This repository is a Pi package. `package.json` declares:

```json
{
  "pi": {
    "extensions": ["./extensions"]
  }
}
```

## License

MIT
