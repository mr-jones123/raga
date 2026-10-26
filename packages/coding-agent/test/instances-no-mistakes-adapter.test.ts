import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { NO_MISTAKES_PIN, NoMistakesBackend } from "../src/core/instances/no-mistakes.ts";

const temporary: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function adapterFixture(reply: string, options: { missingEnd?: boolean; changedSession?: boolean } = {}) {
	const project = await mkdtemp(join(tmpdir(), "raga-adapter-"));
	temporary.push(project);
	const agent = join(project, "agent.mjs");
	await writeFile(
		agent,
		`
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('fixture-agent');
else if (args.includes('--help')) console.log('--mode --session --no-session --no-context-files');
else {
  const resumed = args.includes('--session');
  const id = resumed && ${Boolean(options.changedSession)} ? '22222222-2222-4222-8222-222222222222' : '11111111-1111-4111-8111-111111111111';
  console.log(JSON.stringify({type:'session',id}));
  console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:${JSON.stringify(reply)}}]}}));
  if (!${Boolean(options.missingEnd)}) console.log(JSON.stringify({type:'agent_end'}));
}
`,
	);
	const backend = new NoMistakesBackend({
		instanceRoot: join(project, ".raga"),
		projectRoot: project,
		agent: { executable: process.execPath, args: [agent], version: "fixture-agent" },
	});
	await mkdir(dirname(backend.executable), { recursive: true });
	await writeFile(
		backend.executable,
		"#!/bin/sh\nif [ \"$1 $2\" = 'daemon status' ]; then echo 'daemon running'; fi\nexit 0\n",
		{ mode: 0o700 },
	);
	vi.spyOn(backend, "inspect").mockResolvedValue({
		version: NO_MISTAKES_PIN.version,
		installed: true,
		enabled: false,
		executable: backend.executable,
		prerequisites: [],
	});
	return backend;
}

it.each([
	'{"raga_adapter_probe":true}',
	'```json\n{"raga_adapter_probe":true}\n```',
	'```\n{"raga_adapter_probe":true}\n```',
])("enables a Pi JSON adapter whose completed probe response is %s", async (reply) => {
	const backend = await adapterFixture(reply);
	const result = await backend.enable({ approved: true, network: true });
	expect(result.exitCode).toBe(0);
});

it.each([
	{ reply: '```json\n{"raga_adapter_probe":false}\n```' },
	{ reply: 'Explanation\n```json\n{"raga_adapter_probe":true}\n```' },
	{ reply: '```json\n{"raga_adapter_probe":true}\n```', missingEnd: true },
	{ reply: '```json\n{"raga_adapter_probe":true}\n```', changedSession: true },
])("rejects an invalid probe or broken durable session contract %j", async ({ reply, ...options }) => {
	const backend = await adapterFixture(reply, options);
	await expect(backend.enable({ approved: true, network: true })).rejects.toThrow(
		/Pi JSON event or durable-session contract/,
	);
});

it.each(['"01M5SXMZQPJHRJGEWAPEA59JV0"', "01M5SXMZQPJHRJGEWAPEA59JV0"])(
	"retains authorization and gates reattachment for run ID %s",
	async (id) => {
		const backend = await adapterFixture('{"raga_adapter_probe":true}');
		await backend.enable({ approved: true, network: true });
		const marker = join(backend.root, "launched");
		await writeFile(
			backend.executable,
			`#!/bin/sh
if [ "$1 $2" = 'daemon status' ]; then
  echo 'daemon running'
elif [ "$1 $2" = 'axi run' ]; then
  touch '${marker}'
  printf 'launch_receipt:\\n  run_id: ${id}\\nrun:\\n  id: ${id}\\ngate:\\n  step: test\\n'
elif [ "$1 $2" = 'axi respond' ]; then
  printf 'gate:\\n  step: test\\n'
elif [ "$1" = 'axi' ] && [ -f '${marker}' ]; then
  printf 'active_run:\\n  id: ${id}\\n'
fi
`,
			{ mode: 0o700 },
		);
		const result = await backend.run({ intent: "Validate fixture", approval: { network: true } });
		expect(result).toMatchObject({ state: "gate", skipped: ["push", "pr", "ci"], fullyVerified: false });
		const record = JSON.parse(await readFile(join(backend.root, "runs", "01M5SXMZQPJHRJGEWAPEA59JV0.json"), "utf8"));
		expect(record).toMatchObject({ network: true, skipped: ["push", "pr", "ci"] });
		await expect(backend.run({ intent: "Different intent", approval: { network: true } })).rejects.toThrow(
			/different authorization or intent/,
		);
		const response = await backend.respond({ action: "approve", approved: true });
		expect(response).toMatchObject({ state: "gate", skipped: ["push", "pr", "ci"], fullyVerified: false });
	},
);
