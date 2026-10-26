import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const COMMAND_TIMEOUT = 300_000;
const BUILD_TIMEOUT = 1_800_000;
const SECURITY = [
	"--cap-drop", "ALL", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "SETFCAP",
	"--security-opt", "seccomp=unconfined", "--security-opt", "apparmor=unconfined",
	"--security-opt", "systempaths=unconfined",
];
const RUNTIME_FILES = ["broker-client.ts", "container-control.mjs"];
const EXCLUDED_PATCH_PATHS = [".raga", ".gopath", ".gocache", ".raga-go-cache"];
const hash = (data) => createHash("sha256").update(data).digest("hex");
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const emit = (onEvent, type, fields = {}) => onEvent?.({ type, ...fields });

async function exists(path) {
	try { await lstat(path); return true; }
	catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function command(binary, argv, { cwd, input, timeoutMs = COMMAND_TIMEOUT, signal, onInterrupt } = {}) {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Command timeout must be positive and finite");
	signal?.throwIfAborted();
	return new Promise((resolveCommand, reject) => {
		const child = spawn(binary, argv, { cwd, stdio: ["pipe", "pipe", "pipe"], detached: true });
		const stdout = [];
		const stderr = [];
		let timedOut = false;
		let cancelled = false;
		let cleanup = Promise.resolve();
		const interrupt = (reason) => {
			if (timedOut || cancelled) return;
			timedOut = reason === "timeout";
			cancelled = reason === "cancelled";
			cleanup = Promise.resolve().then(() => onInterrupt?.(reason)).catch(() => {});
			try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") child.kill("SIGKILL"); }
		};
		const abort = () => interrupt("cancelled");
		const timer = setTimeout(() => interrupt("timeout"), timeoutMs);
		signal?.addEventListener("abort", abort, { once: true });
		const detach = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
		child.stdout.on("data", (chunk) => stdout.push(chunk));
		child.stderr.on("data", (chunk) => stderr.push(chunk));
		child.stdin.on("error", (error) => { if (error.code !== "EPIPE" && error.code !== "ECONNRESET") child.kill("SIGKILL"); });
		child.once("error", (error) => { detach(); reject(error); });
		child.once("close", async (exitCode, exitSignal) => {
			detach();
			await cleanup;
			resolveCommand({ exitCode, signal: exitSignal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), timedOut, cancelled });
		});
		child.stdin.end(input);
	});
}

function requireSuccess(result, description) {
	if (result.timedOut || result.exitCode !== 0) {
		const error = new Error(`${description} ${result.timedOut ? "timed out" : `exited ${result.exitCode}`}\n${result.stderr.slice(-12000)}\n${result.stdout.slice(-12000)}`);
		error.result = result;
		throw error;
	}
	return result;
}

async function docker(argv, options) {
	return requireSuccess(await command("docker", argv, options), `docker ${argv[0]}`);
}

async function inspectImage(image) {
	return JSON.parse((await docker(["image", "inspect", image])).stdout)[0];
}

async function digestTree(root) {
	const digest = createHash("sha256");
	async function visit(directory, prefix = "") {
		for (const name of (await readdir(directory)).sort()) {
			const path = join(directory, name);
			const relative = prefix ? `${prefix}/${name}` : name;
			const stat = await lstat(path);
			if (stat.isSymbolicLink()) throw new Error(`Symlink is not allowed in build context: ${relative}`);
			if (stat.isDirectory()) await visit(path, relative);
			else if (stat.isFile()) {
				digest.update(`${relative}\0${stat.mode & 0o777}\0${stat.size}\0`);
				digest.update(await readFile(path));
			} else throw new Error(`Unsupported build context entry: ${relative}`);
		}
	}
	await visit(root);
	return digest.digest("hex");
}

async function retrieveDataset(config, cacheRoot, onEvent) {
	const revision = config.dataset.revision;
	if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("Dataset revision must be a full commit hash");
	const ids = config.tasks.map(({ id }) => {
		if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`Invalid task ID: ${id}`);
		return id;
	});
	if (new Set(ids).size !== ids.length || !ids.length) throw new Error("Task IDs must be nonempty and unique");
	const datasetRoot = join(cacheRoot, `dataset-${revision}-${hash(JSON.stringify(ids.slice().sort())).slice(0, 12)}`);
	if (!(await exists(datasetRoot))) {
		const staging = await mkdtemp(join(cacheRoot, ".dataset-"));
		try {
			emit(onEvent, "dataset_fetch", { repository: config.dataset.repository, revision, taskIds: ids });
			const git = async (argv, options = {}) => requireSuccess(await command("git", ["-C", staging, ...argv], options), `git ${argv[0]}`);
			await git(["init", "--quiet"]);
			await git(["remote", "add", "origin", config.dataset.repository]);
			await git(["config", "remote.origin.promisor", "true"]);
			await git(["config", "remote.origin.partialclonefilter", "blob:none"]);
			await git(["sparse-checkout", "init", "--no-cone"]);
			const patterns = ids.flatMap((id) => ["task.toml", "instruction.md", "environment/Dockerfile", "tests/"].map((entry) => `/tasks/${id}/${entry}`));
			await git(["sparse-checkout", "set", "--no-cone", "--stdin"], { input: `${patterns.join("\n")}\n` });
			await git(["fetch", "--quiet", "--depth=1", "--filter=blob:none", "origin", revision], { timeoutMs: BUILD_TIMEOUT });
			await git(["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", "FETCH_HEAD"], { timeoutMs: BUILD_TIMEOUT });
			try { await rename(staging, datasetRoot); }
			catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error; }
		} finally { await rm(staging, { recursive: true, force: true }); }
	}
	const head = requireSuccess(await command("git", ["-C", datasetRoot, "rev-parse", "HEAD"]), "Dataset revision check").stdout.trim();
	const dirty = requireSuccess(await command("git", ["-C", datasetRoot, "status", "--porcelain"]), "Dataset integrity check").stdout.trim();
	if (head !== revision || dirty) throw new Error("Private dataset cache does not match its pinned revision");
	return datasetRoot;
}

async function parseTask(path) {
	const result = requireSuccess(await command("python3", ["-c", "import json,sys,tomllib; print(json.dumps(tomllib.load(open(sys.argv[1], 'rb'))))", path]), "Task TOML parsing");
	return JSON.parse(result.stdout);
}

function imageMetadata(image) {
	return { id: image.Id, repoDigests: image.RepoDigests ?? [], architecture: image.Architecture, os: image.Os, created: image.Created };
}

async function runtimeVersions(image) {
	const name = `raga-deepswe-versions-${randomUUID()}`;
	try {
		await docker(["create", "--name", name, "--network", "none", "--cap-drop", "ALL", "--entrypoint", "/bin/sh", image, "-c",
			"node --version && /opt/raga-python/bin/python --version && /opt/raga-python/bin/python -c 'import dill; print(\"dill\", dill.__version__)' && bwrap --version && go version"]);
		const result = await docker(["start", "--attach", name], {
			timeoutMs: COMMAND_TIMEOUT,
			onInterrupt: () => command("docker", ["kill", name], { timeoutMs: 30_000 }),
		});
		const state = JSON.parse((await docker(["inspect", name])).stdout)[0].State;
		if (state.Running || state.ExitCode !== 0 || state.OOMKilled || state.Error) throw new Error(`Runtime version collection failed: ${JSON.stringify(state)}`);
		return result.stdout.trim();
	} finally {
		const result = await command("docker", ["rm", "--force", "--volumes", name], { timeoutMs: 30_000 });
		if (result.exitCode !== 0 && !result.stderr.includes("No such container")) requireSuccess(result, "Runtime metadata cleanup");
	}
}

export async function prepareEnvironment({ config, cacheRoot, benchmarkDir, onEvent }) {
	cacheRoot = resolve(cacheRoot);
	benchmarkDir = resolve(benchmarkDir);
	await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
	await chmod(cacheRoot, 0o700);
	const datasetRoot = await retrieveDataset(config, cacheRoot, onEvent);
	const contexts = await mkdtemp(join(cacheRoot, ".contexts-"));
	try {
		const runtimeContext = join(contexts, "runtime");
		await mkdir(runtimeContext);
		await copyFile(join(benchmarkDir, "Runtime.Dockerfile"), join(runtimeContext, "Dockerfile"));
		if (await exists(join(benchmarkDir, "go-wrapper"))) await cp(join(benchmarkDir, "go-wrapper"), join(runtimeContext, "go-wrapper"));
		const runtimeRecipeDigest = await digestTree(runtimeContext);
		const tasks = {};
		for (const pin of config.tasks) {
			if (!/^[0-9a-f]{40}$/.test(pin.baseCommit) || !/@sha256:[0-9a-f]{64}$/.test(pin.image)) throw new Error(`Task ${pin.id} needs immutable source and image pins`);
			const taskDir = join(datasetRoot, "tasks", pin.id);
			const specification = await parseTask(join(taskDir, "task.toml"));
			if (specification.metadata?.base_commit_hash !== pin.baseCommit || specification.metadata?.repository_url !== pin.repository || specification.metadata?.task_id !== pin.id) throw new Error(`Task metadata disagrees with config: ${pin.id}`);
			if (specification.verifier?.environment_mode !== "separate" || specification.verifier?.network_mode !== "no-network" || specification.agent?.network_mode !== "no-network") throw new Error(`Unsupported task isolation contract: ${pin.id}`);
			if (JSON.stringify(specification.artifacts) !== JSON.stringify(["/logs/artifacts/model.patch"]) || specification.verifier.collect?.length !== 1) throw new Error(`Unsupported artifact contract: ${pin.id}`);
			emit(onEvent, "image_prepare_start", { taskId: pin.id, image: pin.image });
			let sourceImage;
			try { sourceImage = await inspectImage(pin.image); }
			catch { await docker(["pull", pin.image], { timeoutMs: BUILD_TIMEOUT }); sourceImage = await inspectImage(pin.image); }
			if (!sourceImage.RepoDigests?.includes(pin.image)) throw new Error(`Pulled image does not resolve pinned digest: ${pin.image}`);
			const verifierContext = join(contexts, `${pin.id}-verifier`);
			await cp(join(taskDir, "tests"), verifierContext, { recursive: true, preserveTimestamps: true });
			const verifierRecipe = await readFile(join(verifierContext, "Dockerfile"), "utf8");
			const fromLines = verifierRecipe.match(/^FROM\s+[^\r\n]+/gmi) ?? [];
			if (fromLines.length !== 1 || fromLines[0].trim().split(/\s+/)[1] !== specification.environment?.docker_image) throw new Error(`Unsupported verifier base image: ${pin.id}`);
			await writeFile(join(verifierContext, "Dockerfile"), verifierRecipe.replace(/^FROM\s+[^\r\n]+/mi, `FROM ${pin.image}`));
			const verifierContextDigest = await digestTree(verifierContext);
			const agentTag = `raga-deepswe-agent:${hash(`${pin.image}\0${runtimeRecipeDigest}`).slice(0, 24)}`;
			const verifierTag = `raga-deepswe-verifier:${hash(`${pin.image}\0${verifierContextDigest}`).slice(0, 24)}`;
			await docker(["build", "--build-arg", `TASK_IMAGE=${pin.image}`, "--tag", agentTag, runtimeContext], { timeoutMs: BUILD_TIMEOUT });
			await docker(["build", "--tag", verifierTag, verifierContext], { timeoutMs: BUILD_TIMEOUT });
			const agentImage = await inspectImage(agentTag);
			const verifierImage = await inspectImage(verifierTag);
			if (Object.keys(agentImage.Config?.Volumes ?? {}).length) throw new Error(`Task image declares volumes that docker commit cannot checkpoint: ${pin.id}`);
			const versions = await runtimeVersions(agentImage.Id);
			const metadata = {
				dataset: { ...config.dataset }, sourceImage: imageMetadata(sourceImage), agentImage: imageMetadata(agentImage), verifierImage: imageMetadata(verifierImage),
				runtimeRecipeDigest, verifierContextDigest, runtimeVersions: versions, hostNodeVersion: process.version,
				security: { network: "none", dockerFlags: SECURITY, privileged: false },
				patchPolicy: { supervisorCommit: true, excludedPaths: EXCLUDED_PATCH_PATHS, collectionCommand: specification.verifier.collect[0].command },
				verifier: { command: ["bash", "/tests/test.sh"], timeoutMs: specification.verifier.timeout_sec * 1000 },
			};
			tasks[pin.id] = { id: pin.id, baseCommit: pin.baseCommit, image: sourceImage.Id, agentImage: agentImage.Id, verifierImage: verifierImage.Id, instruction: await readFile(join(taskDir, "instruction.md"), "utf8"), taskDir, metadata };
			await writeFile(join(cacheRoot, `${pin.id}.prepared.json`), `${JSON.stringify(tasks[pin.id], null, 2)}\n`, { mode: 0o600 });
			emit(onEvent, "image_prepare_complete", { taskId: pin.id, metadata });
		}
		return { datasetRoot, tasks, runtimeRecipeDigest };
	} finally { await rm(contexts, { recursive: true, force: true }); }
}

function resourceFlags(limits = {}) {
	const cpus = limits.cpus ?? 2;
	const memoryMb = limits.memoryMb ?? 8192;
	if (!Number.isFinite(cpus) || cpus <= 0 || !Number.isSafeInteger(memoryMb) || memoryMb <= 0) throw new Error("Container resource limits must be positive");
	return ["--cpus", String(cpus), "--memory", `${memoryMb}m`, "--memory-swap", `${memoryMb}m`];
}

function bind(source, target) {
	if (source.includes(",") || target.includes(",")) throw new Error("Docker bind paths cannot contain commas");
	return ["--mount", `type=bind,src=${source},dst=${target},readonly`];
}

function containerHandle(id, onEvent) {
	let destroyPromise;
	const assertLive = () => { if (destroyPromise) throw new Error(`Container is destroyed: ${id}`); };
	return {
		id,
		async exec(argv, { input, timeoutMs = COMMAND_TIMEOUT, cwd, signal } = {}) {
			assertLive();
			return command("docker", ["exec", "-i", ...(cwd ? ["--workdir", cwd] : []), id, ...argv], {
				input, timeoutMs, signal,
				onInterrupt: async (reason) => {
					emit(onEvent, `container_exec_${reason}`, { containerId: id, timeoutMs });
					await command("docker", ["kill", id], { timeoutMs: 30_000 });
				},
			});
		},
		async copyIn(hostPath, containerPath) {
			assertLive();
			await docker(["cp", resolve(hostPath), `${id}:${containerPath}`]);
		},
		async copyOut(containerPath, hostPath) {
			assertLive();
			await mkdir(dirname(resolve(hostPath)), { recursive: true });
			await docker(["cp", `${id}:${containerPath}`, resolve(hostPath)]);
		},
		async checkpoint() {
			assertLive();
			const imageId = (await docker(["commit", "--pause=true", id], { timeoutMs: BUILD_TIMEOUT })).stdout.trim();
			if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) throw new Error("Docker returned an invalid checkpoint image ID");
			emit(onEvent, "container_checkpoint", { containerId: id, imageId });
			return imageId;
		},
		destroy() {
			destroyPromise ??= (async () => {
				const result = await command("docker", ["rm", "--force", "--volumes", id], { timeoutMs: 30_000 });
				if (result.exitCode !== 0 && !result.stderr.includes("No such container")) requireSuccess(result, "Container cleanup");
				emit(onEvent, "container_destroy", { containerId: id });
			})();
			return destroyPromise;
		},
	};
}

export async function createTaskContainer({ task, sourceRoot, benchmarkDir, socketDir, image, onEvent, limits }) {
	sourceRoot = await realpath(sourceRoot);
	benchmarkDir = await realpath(benchmarkDir);
	socketDir = await realpath(socketDir);
	const selectedImage = image ?? task.agentImage;
	if (!/^sha256:[0-9a-f]{64}$/.test(selectedImage)) throw new Error("Task containers require immutable local image IDs");
	const mounts = [];
	for (const name of ["node_modules", "package.json", "tsconfig.json", "tsconfig.base.json"]) {
		const path = join(sourceRoot, name);
		await lstat(path);
		mounts.push(...bind(path, path));
	}
	for (const entry of (await readdir(join(sourceRoot, "packages"), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory()) continue;
		const path = join(sourceRoot, "packages", entry.name);
		mounts.push(...bind(path, path));
	}
	for (const file of RUNTIME_FILES) {
		const path = join(benchmarkDir, file);
		if (!(await lstat(path)).isFile()) throw new Error(`Runtime mount must be a regular file: ${path}`);
		mounts.push(...bind(path, `/opt/raga-bench/${file}`));
	}
	mounts.push(...bind(socketDir, "/run/raga-broker"));
	const name = `raga-deepswe-${randomUUID()}`;
	const container = containerHandle(name, onEvent);
	try {
		await docker(["create", "--name", name, "--init", "--network", "none", ...resourceFlags(limits), ...SECURITY, ...mounts,
			"--workdir", "/app", "--user", "0:0", "--env", "HOME=/home/agent", "--env", "PI_CODING_AGENT_DIR=/var/lib/raga-agent",
			"--env", `RAGA_BENCH_SOURCE=${sourceRoot}`, "--env", "RAGA_PYTHON=/opt/raga-python/bin/python", "--env", "PI_OFFLINE=1",
			"--entrypoint", "/bin/sh", selectedImage, "-c", "exec sleep infinity"]);
		await docker(["start", name]);
		requireSuccess(await container.exec(["bash", "-lc", "mkdir -p /home/agent /var/lib/raga-agent /var/lib/raga-sessions /app/.gopath/bin && printf '%s\\n' .raga .gopath >> .git/info/exclude"]), "Container state initialization");
		if (!image) {
			const head = requireSuccess(await container.exec(["git", "-c", "safe.directory=/app", "-C", "/app", "rev-parse", "HEAD"]), "Task base commit check").stdout.trim();
			if (head !== task.baseCommit) throw new Error(`Task image HEAD ${head} differs from pinned base ${task.baseCommit}`);
			const dirty = requireSuccess(await container.exec(["git", "-c", "safe.directory=/app", "-C", "/app", "status", "--porcelain"]), "Task image cleanliness check").stdout.trim();
			if (dirty) throw new Error(`Task image has uncommitted files before solving: ${dirty}`);
		}
		emit(onEvent, "container_create", { containerId: name, taskId: task.id, image: selectedImage, sourceRoot, mounts, security: SECURITY, limits });
		return container;
	} catch (error) {
		try { await container.destroy(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Task creation and cleanup failed"); }
		throw error;
	}
}

export async function capturePatch({ container, task, outputDir }) {
	outputDir = resolve(outputDir);
	await mkdir(outputDir, { recursive: true });
	// Raga masks .git, so both arms use this same supervisor-owned final commit.
	const script = [
		"set -eu", "cd /app", "mkdir -p /var/lib/raga-supervisor", "export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/var/lib/raga-supervisor/gitconfig",
		"git config --global --add safe.directory /app", "git config --local core.hooksPath /dev/null",
		`git cat-file -e ${quote(`${task.baseCommit}^{commit}`)}`,
		"git add -A -- .",
		"if ! git diff --cached --quiet; then git -c user.name='DeepSWE supervisor' -c user.email='deepswe@localhost' -c commit.gpgsign=false commit --quiet -m 'Capture candidate workspace'; fi",
		task.metadata.patchPolicy.collectionCommand,
		"git rev-parse HEAD",
	].join("\n");
	const result = requireSuccess(await container.exec(["bash", "-c", script], { timeoutMs: COMMAND_TIMEOUT }), "Candidate patch capture");
	const head = result.stdout.trim().split("\n").at(-1);
	if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("Patch collection did not produce a valid HEAD");
	const path = join(outputDir, "model.patch");
	await container.copyOut("/logs/artifacts/model.patch", path);
	const patch = await readFile(path);
	return { path, sha256: hash(patch), bytes: patch.length, head, baseCommit: task.baseCommit };
}

export async function verifyPatch({ task, patchPath, outputDir, timeoutMs = 1_800_000, limits, onEvent, signal }) {
	outputDir = resolve(outputDir);
	await mkdir(outputDir, { recursive: true });
	let rawDirectory = join(outputDir, "verifier");
	for (let attempt = 2; await exists(rawDirectory); attempt++) rawDirectory = join(outputDir, `verifier-${attempt}`);
	await mkdir(rawDirectory);
	const staging = await mkdtemp(join(outputDir, ".verifier-input-"));
	const name = `raga-deepswe-verifier-${randomUUID()}`;
	let result;
	let cleanupError;
	let invocationError;
	try {
		await copyFile(resolve(patchPath), join(staging, "model.patch"));
	await chmod(staging, 0o755);
	await chmod(join(staging, "model.patch"), 0o644);
	await chmod(rawDirectory, 0o777);
		emit(onEvent, "verifier_start", { taskId: task.id, containerId: name, image: task.verifierImage, timeoutMs });
		await docker(["create", "--name", name, "--network", "none", ...resourceFlags(limits), "--cap-drop", "ALL", "--user", "0:0",
			...bind(staging, "/logs/artifacts"), "--mount", `type=bind,src=${rawDirectory},dst=/logs/verifier`,
			"--workdir", "/app", "--entrypoint", "/bin/bash", task.verifierImage, "/tests/test.sh"]);
		result = await command("docker", ["start", "--attach", name], { timeoutMs, signal, onInterrupt: () => command("docker", ["kill", name], { timeoutMs: 30_000 }) });
		await writeFile(join(rawDirectory, "test-stdout.txt"), result.stdout);
		await writeFile(join(rawDirectory, "test-stderr.txt"), result.stderr);
		if (result.cancelled) throw new Error("Verifier invocation was cancelled");
		if (!result.timedOut) {
			const inspect = JSON.parse((await docker(["inspect", name])).stdout)[0];
			if (inspect.State.Running || inspect.State.OOMKilled || inspect.State.Error) throw new Error(`Verifier process did not exit cleanly: ${JSON.stringify(inspect.State)}`);
			result.exitCode = inspect.State.ExitCode;
		}
	} catch (error) { invocationError = error.message; }
	finally {
		try {
			const removed = await command("docker", ["rm", "--force", "--volumes", name], { timeoutMs: 30_000 });
			if (removed.exitCode !== 0 && !removed.stderr.includes("No such container")) requireSuccess(removed, "Verifier cleanup");
		} catch (error) { cleanupError = error.message; }
		await rm(staging, { recursive: true, force: true });
	}
	let reward = null;
	let details = null;
	let rewardError;
	try {
		if (await exists(join(rawDirectory, "reward.json"))) {
			details = JSON.parse(await readFile(join(rawDirectory, "reward.json"), "utf8"));
			reward = details.reward;
		} else {
			const text = await readFile(join(rawDirectory, "reward.txt"), "utf8");
			details = { rawRewardText: text };
			const values = text.split("\n").map((line) => line.trim()).filter(Boolean);
			const parsed = Number(values.at(-1));
			if (!values.length || !Number.isFinite(parsed)) throw new Error("Verifier reward.txt did not contain a number");
			reward = parsed;
		}
		if (typeof reward !== "number" || !Number.isFinite(reward) || reward < 0 || reward > 1) throw new Error("Verifier reward must be a finite number between 0 and 1");
	} catch (error) { reward = null; rewardError = error.message; }
	const status = result?.timedOut ? "timeout" : invocationError || cleanupError || rewardError || result?.exitCode !== 0 ? "error" : reward === 1 ? "passed" : "failed";
	const verification = { status, reward, details, taskId: task.id, image: task.verifierImage, exitCode: result?.exitCode ?? null, timedOut: result?.timedOut ?? false, artifactsPath: rawDirectory, error: [invocationError, rewardError, cleanupError].filter(Boolean).join("\n") || null };
	await writeFile(join(outputDir, "verification.json"), `${JSON.stringify(verification, null, 2)}\n`);
	emit(onEvent, "verifier_complete", verification);
	return verification;
}
