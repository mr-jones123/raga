// Adapted from Prime Agent (MIT), github.com/PrimeIntellect-ai/prime-agent
/**
 * Finds or provisions the Python interpreter for the RLM kernel. See docs/RLM.md "Python interpreter".
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import { getAgentDir, getPackageDir } from "../../config.ts";

const execFileAsync = promisify(execFile);

export interface PythonEnv {
	python: string;
	runtimeDir: string;
	hasDill: boolean;
	runtimeRoots: string[];
	modulePaths: string[];
}

const MIN_PYTHON: readonly [number, number] = [3, 11];
const PROBE_TIMEOUT_MS = 15_000;
const PROVISION_TIMEOUT_MS = 10 * 60_000;
/** Lock is considered abandoned when its mtime is older than this; holders refresh it at half the interval. */
const LOCK_STALE_MS = 30_000;

const PROBE_SCRIPT =
	'import importlib.util, json, site, sys; print(json.dumps({"version": list(sys.version_info[:3]), "dill": importlib.util.find_spec("dill") is not None, "executable": sys.executable, "roots": [sys.prefix, sys.base_prefix], "modules": site.getsitepackages()}))';

async function checkInterpreter(python: string, source: string): Promise<Omit<PythonEnv, "runtimeDir">> {
	let probe: {
		version: [number, number, number];
		dill: boolean;
		executable: string;
		roots: string[];
		modules: string[];
	};
	try {
		const { stdout } = await execFileAsync(python, ["-c", PROBE_SCRIPT], {
			timeout: PROBE_TIMEOUT_MS,
			windowsHide: true,
		});
		probe = JSON.parse(stdout.trim());
	} catch (error) {
		const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
		throw new Error(
			missing
				? `RLM: ${python} (${source}) not found`
				: `RLM: cannot run ${python} (${source}): ${errorText(error)}`,
		);
	}
	const [major, minor, micro] = probe.version;
	if (!(major > MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor >= MIN_PYTHON[1]))) {
		throw new Error(
			`RLM: ${python} (${source}) is Python ${major}.${minor}.${micro}; Python ${MIN_PYTHON.join(".")} or newer is required`,
		);
	}
	return {
		python: probe.executable,
		hasDill: probe.dill,
		runtimeRoots: [...new Set(probe.roots)],
		modulePaths: probe.modules,
	};
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function venvPython(venvDir: string): string {
	return process.platform === "win32" ? join(venvDir, "Scripts", "python.exe") : join(venvDir, "bin", "python");
}

/**
 * Create `<rlmDir>/venv` with uv. A lock file serializes concurrent sessions: the second one
 * waits for the first, then sees the finished venv. A failed provisioning removes the partial venv
 * so a later run does not pick up an interpreter without dill.
 */
async function provisionVenv(rlmDir: string, venvDir: string): Promise<void> {
	mkdirSync(rlmDir, { recursive: true });
	const release = await lockfile.lock(rlmDir, {
		lockfilePath: join(rlmDir, "venv.lock"),
		stale: LOCK_STALE_MS,
		retries: { retries: Math.ceil(PROVISION_TIMEOUT_MS / 1000), factor: 1, minTimeout: 1000, maxTimeout: 1000 },
	});
	try {
		if (existsSync(venvPython(venvDir))) return;
		const options = { timeout: PROVISION_TIMEOUT_MS, windowsHide: true };
		try {
			await execFileAsync("uv", ["venv", "--python", "3.11", venvDir], options);
			await execFileAsync("uv", ["pip", "install", "--python", venvPython(venvDir), "dill"], options);
		} catch (error) {
			rmSync(venvDir, { recursive: true, force: true });
			throw error;
		}
	} finally {
		await release();
	}
}

/**
 * Pick the interpreter: `RAGA_PYTHON`, then `<agentDir>/rlm/venv`, then a new uv venv at that
 * path, then `python3` on PATH. The interpreter must be Python 3.11 or newer.
 */
export async function resolvePythonEnv(options: { agentDir?: string } = {}): Promise<PythonEnv> {
	const runtimeDir = join(getPackageDir(), "python");
	const override = process.env.RAGA_PYTHON;
	if (override) return { ...(await checkInterpreter(override, "RAGA_PYTHON")), runtimeDir };

	const rlmDir = join(options.agentDir ?? getAgentDir(), "rlm");
	const venvDir = join(rlmDir, "venv");
	const venvInterpreter = venvPython(venvDir);
	if (existsSync(venvInterpreter)) return { ...(await checkInterpreter(venvInterpreter, "RLM venv")), runtimeDir };

	let provisionError: unknown;
	const uvAvailable = await execFileAsync("uv", ["--version"], { timeout: PROBE_TIMEOUT_MS, windowsHide: true }).then(
		() => true,
		() => false,
	);
	if (uvAvailable) {
		try {
			await provisionVenv(rlmDir, venvDir);
			return { ...(await checkInterpreter(venvInterpreter, "RLM venv")), runtimeDir };
		} catch (error) {
			provisionError = error;
		}
	}

	const fallback = process.platform === "win32" ? "python" : "python3";
	try {
		return { ...(await checkInterpreter(fallback, "PATH")), runtimeDir };
	} catch (error) {
		const provisionNote = provisionError ? `; uv provisioning failed: ${errorText(provisionError)}` : "";
		throw new Error(`${errorText(error)}${provisionNote}`);
	}
}
