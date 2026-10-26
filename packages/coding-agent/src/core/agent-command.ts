import { resolve } from "node:path";
import { isBunBinary, VERSION } from "../config.ts";

export interface AgentCommand {
	executable: string;
	args: string[];
	version: string;
}

/** The current CLI, so helper commands launch the same executable the user ran. */
export function agentCommand(): AgentCommand {
	if (!isBunBinary && !process.argv[1]) throw new Error("Cannot locate the current CLI entry point.");
	const runtimeArgs = process.execArgv.map((arg, index, args) => {
		const option = /^(--import|--loader|--require|-r)=(.*)$/.exec(arg);
		if (option && /^\.{1,2}\//.test(option[2])) return `${option[1]}=${resolve(option[2])}`;
		if (["--import", "--loader", "--require", "-r"].includes(args[index - 1]) && /^\.{1,2}\//.test(arg)) {
			return resolve(arg);
		}
		return arg;
	});
	return {
		executable: process.execPath,
		args: isBunBinary ? [] : [...runtimeArgs, resolve(process.argv[1])],
		version: VERSION,
	};
}
