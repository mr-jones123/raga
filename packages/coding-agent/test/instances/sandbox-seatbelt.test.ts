import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkSandbox, sandboxCommand } from "../../src/core/instances/sandbox.ts";

const status = await checkSandbox("writes");

describe.runIf(process.platform === "darwin")("Seatbelt sandbox (confinement: writes)", () => {
	let workspace: string;
	let outside: string;
	/** Outside every writable root, like the Docker and SSH agent sockets; short because socket paths cap at 104 bytes. */
	let outsideSockets: string;
	let server: Server;
	let port: number;

	const sh = (script: string, network?: boolean) =>
		sandboxCommand({
			command: "/bin/sh",
			args: ["-c", script],
			policy: { workspace, readOnly: [], writable: [], confinement: "writes", network },
			timeoutMs: 10_000,
		});

	beforeAll(async () => {
		workspace = await realpath(await mkdtemp(join(tmpdir(), "raga-seatbelt-ws-")));
		outside = await realpath(await mkdtemp(join(tmpdir(), "raga-seatbelt-out-")));
		outsideSockets = await realpath(await mkdtemp("/Users/Shared/raga-sock-"));
		server = createServer((socket) => socket.end()).listen(0, "127.0.0.1");
		await new Promise((resolve) => server.once("listening", resolve));
		port = (server.address() as { port: number }).port;
	});

	afterAll(async () => {
		server.close();
		await rm(workspace, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
		await rm(outsideSockets, { recursive: true, force: true });
	});

	it("is available on macOS, while full confinement still needs bubblewrap", async () => {
		expect(status).toEqual({ available: true });
		expect((await checkSandbox()).available).toBe(false);
	});

	it("allows writes in the workspace and /tmp, and denies them elsewhere", async () => {
		expect((await sh("echo inside > f && echo t > /tmp/raga-seatbelt-t && rm /tmp/raga-seatbelt-t")).exitCode).toBe(
			0,
		);
		expect(readFileSync(join(workspace, "f"), "utf8")).toBe("inside\n");
		const escaped = await sh(`echo x > ${join(outside, "f")}`);
		expect(escaped.exitCode).not.toBe(0);
		expect(escaped.stderr).toContain("Operation not permitted");
		expect(existsSync(join(outside, "f"))).toBe(false);
	});

	it("denies reading credential paths", async () => {
		const result = await sh(`cat ${join(homedir(), ".ssh", "config")} ${join(homedir(), ".npmrc")}`);
		expect(result.stdout).toBe("");
		expect(result.exitCode).not.toBe(0);
	});

	it("lets tests listen and reach loopback, and blocks outbound network unless enabled", async () => {
		const listen = `node -e 'require("net").createServer().listen(0, () => { console.log("listening"); process.exit(0) })'`;
		expect((await sh(listen)).stdout.trim()).toBe("listening");
		expect((await sh(`nc -z 127.0.0.1 ${port}`)).exitCode).toBe(0);
		expect((await sh("nc -z -w 3 1.1.1.1 443")).exitCode).not.toBe(0);
		expect((await sh("nc -z -w 3 1.1.1.1 443", true)).exitCode).toBe(0);
	});

	it("only reaches unix sockets inside writable roots, so not the Docker or SSH agent sockets", async () => {
		// Socket paths are capped at 104 bytes; /tmp is a writable root with a short path.
		const tmpSockets = await realpath(await mkdtemp("/tmp/raga-sock-"));
		const servers = [
			createServer().listen(join(tmpSockets, "in.sock")),
			createServer().listen(join(outsideSockets, "out.sock")),
		];
		await Promise.all(
			servers.map(
				(server) => new Promise((resolve, reject) => server.once("listening", resolve).once("error", reject)),
			),
		);
		try {
			const connect = (path: string) =>
				`node -e 'require("net").connect(${JSON.stringify(path)}).on("connect", () => { console.log("connected"); process.exit(0) }).on("error", (e) => { console.log(e.code); process.exit(1) })'`;
			expect((await sh(connect(join(tmpSockets, "in.sock")))).stdout.trim()).toBe("connected");
			expect((await sh(connect(join(outsideSockets, "out.sock")))).stdout.trim()).toBe("EPERM");
		} finally {
			for (const socketServer of servers) socketServer.close();
			await rm(tmpSockets, { recursive: true, force: true });
		}
	});

	it("cannot start processes outside the sandbox through open, osascript, or launchctl", async () => {
		for (const command of ["/usr/bin/open -g -a TextEdit", "/usr/bin/osascript -e 1", "/bin/launchctl list"]) {
			const result = await sh(command);
			expect(result.exitCode, command).not.toBe(0);
			expect(result.stderr, command).toContain("Operation not permitted");
		}
	});
});
