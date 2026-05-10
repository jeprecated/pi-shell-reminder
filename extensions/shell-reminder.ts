import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

type LocalShellKind = "devbox" | "devenv" | "nix" | "direnv";

type LocalShell = {
	kind: LocalShellKind;
	name: string;
	root: string;
	configPath: string;
	command: string;
	priority: number;
};

type ShellEvaluation =
	| { state: "none" }
	| { state: "active"; shell: LocalShell }
	| { state: "missing"; shell: LocalShell; alternatives: LocalShell[] };

const SHELL_STATUS_KEY = "local-shell";

async function exists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function ancestors(start: string): string[] {
	const dirs: string[] = [];
	let current = resolve(start);
	const home = resolve(homedir());

	while (true) {
		dirs.push(current);
		if (current === home) break;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}

	return dirs;
}

function pathEqualsOrContains(parent: string, child: string): boolean {
	const normalizedParent = resolve(parent);
	const normalizedChild = resolve(child);
	const rel = relative(normalizedParent, normalizedChild);
	return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function samePath(left: string, right: string): boolean {
	return resolve(left) === resolve(right);
}

function envPathMatchesRoot(value: string | undefined, root: string): boolean {
	if (value === undefined) return false;
	return samePath(value, root) || pathEqualsOrContains(root, value);
}

function shortPath(path: string): string {
	const home = resolve(homedir());
	const resolved = resolve(path);
	if (resolved === home) return "~";
	if (pathEqualsOrContains(home, resolved)) return `~/${relative(home, resolved)}`;
	return resolved;
}

async function maybeNixShell(root: string): Promise<LocalShell | undefined> {
	const shellNix = join(root, "shell.nix");
	if (await exists(shellNix)) {
		return {
			kind: "nix",
			name: "Nix dev shell",
			root,
			configPath: shellNix,
			command: "nix-shell",
			priority: 30,
		};
	}

	const flakeNix = join(root, "flake.nix");
	if (await exists(flakeNix)) {
		const contents = await readFile(flakeNix, "utf8").catch(() => "");
		if (/\bdevShells?\b|\bmkShell\b/.test(contents)) {
			return {
				kind: "nix",
				name: "Nix dev shell",
				root,
				configPath: flakeNix,
				command: "nix develop",
				priority: 30,
			};
		}
	}

	const defaultNix = join(root, "default.nix");
	if (await exists(defaultNix)) {
		const contents = await readFile(defaultNix, "utf8").catch(() => "");
		if (/\bmkShell\b/.test(contents)) {
			return {
				kind: "nix",
				name: "Nix dev shell",
				root,
				configPath: defaultNix,
				command: "nix-shell",
				priority: 30,
			};
		}
	}

	return undefined;
}

async function shellsInDirectory(root: string): Promise<LocalShell[]> {
	const shells: LocalShell[] = [];
	const devboxJson = join(root, "devbox.json");
	if (await exists(devboxJson)) {
		shells.push({
			kind: "devbox",
			name: "Devbox",
			root,
			configPath: devboxJson,
			command: "devbox shell",
			priority: 10,
		});
	}

	const devenvNix = join(root, "devenv.nix");
	const devenvYaml = join(root, "devenv.yaml");
	if ((await exists(devenvNix)) || (await exists(devenvYaml))) {
		shells.push({
			kind: "devenv",
			name: "devenv",
			root,
			configPath: (await exists(devenvNix)) ? devenvNix : devenvYaml,
			command: "devenv shell",
			priority: 20,
		});
	}

	const nixShell = await maybeNixShell(root);
	if (nixShell) shells.push(nixShell);

	const envrc = join(root, ".envrc");
	if (await exists(envrc)) {
		shells.push({
			kind: "direnv",
			name: "direnv",
			root,
			configPath: envrc,
			command: "direnv allow && cd .",
			priority: 40,
		});
	}

	return shells.sort((a, b) => a.priority - b.priority);
}

async function findLocalShellGroups(cwd: string): Promise<LocalShell[][]> {
	const groups: LocalShell[][] = [];
	for (const dir of ancestors(cwd)) {
		const shells = await shellsInDirectory(dir);
		if (shells.length > 0) groups.push(shells);
	}
	return groups;
}

function devboxIsActive(shell: LocalShell): boolean {
	if (process.env.DEVBOX_SHELL_ENABLED !== "1" && process.env.DEVBOX_SHELL_ENABLED !== "true") {
		return false;
	}
	return envPathMatchesRoot(process.env.DEVBOX_PROJECT_ROOT ?? process.env.DEVBOX_DIR, shell.root);
}

function devenvIsActive(shell: LocalShell): boolean {
	return envPathMatchesRoot(process.env.DEVENV_ROOT, shell.root) && (process.env.DEVENV_ROOT !== undefined || process.env.DEVENV_PROFILE !== undefined);
}

function nixShellIsActive(shell: LocalShell): boolean {
	if (process.env.IN_NIX_SHELL === undefined && process.env.NIX_SHELL === undefined) return false;

	// Raw nix shells do not consistently expose the project root. If a root-ish
	// variable is available, require it to match; otherwise accept IN_NIX_SHELL as
	// the best signal Nix gives us for normal nix-shell/nix develop sessions.
	const nixRoot = process.env.NIX_SHELL_ROOT ?? process.env.DEVBOX_PROJECT_ROOT ?? process.env.DEVENV_ROOT;
	return nixRoot !== undefined ? envPathMatchesRoot(nixRoot, shell.root) : true;
}

function direnvIsActive(shell: LocalShell): boolean {
	const direnvFile = process.env.DIRENV_FILE;
	if (direnvFile !== undefined && samePath(direnvFile, shell.configPath)) return true;

	const direnvDir = process.env.DIRENV_DIR;
	if (direnvDir !== undefined) {
		if (isAbsolute(direnvDir) && samePath(direnvDir, shell.root)) return true;
		// direnv commonly encodes the directory as a path-ish string. This is intentionally
		// loose because the exact encoding changed across direnv versions.
		const encodedRoot = shell.root.replace(/\//g, "-");
		if (direnvDir === encodedRoot || direnvDir.endsWith(encodedRoot)) return true;
	}

	return false;
}

function shellIsActive(shell: LocalShell): boolean {
	switch (shell.kind) {
		case "devbox":
			return devboxIsActive(shell);
		case "devenv":
			return devenvIsActive(shell);
		case "nix":
			return nixShellIsActive(shell);
		case "direnv":
			return direnvIsActive(shell);
	}
}

async function evaluateLocalShell(cwd: string): Promise<ShellEvaluation> {
	const groups = await findLocalShellGroups(cwd);
	for (const shells of groups) {
		const active = shells.find(shellIsActive);
		if (active) return { state: "active", shell: active };
		return { state: "missing", shell: shells[0], alternatives: shells.slice(1) };
	}
	return { state: "none" };
}

function missingShellMessage(evaluation: Extract<ShellEvaluation, { state: "missing" }>): string {
	const { shell, alternatives } = evaluation;
	const alternateCommands = alternatives.length > 0 ? ` Alternative shell commands detected here: ${alternatives.map((candidate) => candidate.command).join(", ")}.` : "";
	return `${shell.name} shell detected at ${shortPath(shell.configPath)}, but Pi was started outside it. Exit Pi, run \`${shell.command}\` from ${shortPath(shell.root)}, then start Pi again.${alternateCommands}`;
}

async function updateShellReminder(ctx: ExtensionContext, notifyWhenMissing: boolean) {
	const evaluation = await evaluateLocalShell(ctx.cwd);
	if (evaluation.state === "missing") {
		ctx.ui.setStatus(SHELL_STATUS_KEY, `shell: enter ${evaluation.shell.kind}`);
		if (notifyWhenMissing) ctx.ui.notify(missingShellMessage(evaluation), "warning");
		return;
	}

	ctx.ui.setStatus(SHELL_STATUS_KEY, undefined);
	if (notifyWhenMissing && evaluation.state === "active") {
		// Startup should be quiet when everything is correct. The explicit command uses
		// notifyWhenMissing=false and reports the active state itself.
		return;
	}
}

export default function shellReminderExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (event, ctx) => {
		if (!ctx.hasUI) return;
		await updateShellReminder(ctx, event.reason === "startup" || event.reason === "reload");
	});

	pi.registerCommand("shell-check", {
		description: "Check whether Pi was started inside this project's local development shell.",
		handler: async (_args, ctx) => {
			const evaluation = await evaluateLocalShell(ctx.cwd);
			if (evaluation.state === "none") {
				ctx.ui.setStatus(SHELL_STATUS_KEY, undefined);
				ctx.ui.notify("No Devbox, devenv, Nix dev shell, or direnv shell was detected for this directory.", "info");
				return;
			}
			if (evaluation.state === "active") {
				ctx.ui.setStatus(SHELL_STATUS_KEY, undefined);
				ctx.ui.notify(`${evaluation.shell.name} shell appears to be active for ${shortPath(evaluation.shell.root)}.`, "info");
				return;
			}
			ctx.ui.setStatus(SHELL_STATUS_KEY, `shell: enter ${evaluation.shell.kind}`);
			ctx.ui.notify(missingShellMessage(evaluation), "warning");
		},
	});
}

export const __test__ = {
	ancestors,
	devboxIsActive,
	devenvIsActive,
	direnvIsActive,
	envPathMatchesRoot,
	evaluateLocalShell,
	findLocalShellGroups,
	missingShellMessage,
	nixShellIsActive,
	pathEqualsOrContains,
	samePath,
	shellIsActive,
	shellsInDirectory,
	shortPath,
};
