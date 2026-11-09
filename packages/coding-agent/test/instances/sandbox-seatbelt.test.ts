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
		server = createServer((socket) => socket.end()).listen(0, "127.0.0.1");
		await new Promise((resolve) => server.once("listening", resolve));
		port = (server.address() as { port: number }).port;
	});

	afterAll(async () => {
		server.close();
		await rm(workspace, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
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
});
