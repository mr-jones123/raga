/**
 * Subagent roles: which model each workflow role (such as "arena runners" or "bug-fix") runs on, and at
 * what reasoning budget. Ordinary sessions use the user's /agent-setup choices; instance sessions use the
 * pinned revision's agents/model-roles.json. See docs/AGENTS.md.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getBundledHarnessPath } from "./instances/bundle.ts";
import type { AgentRolesSettings } from "./settings-schema.ts";

export type AgentRoleBudget = NonNullable<AgentRolesSettings["budget"]>;
/** A role value: "provider/id", or null for the parent's model. "inherit" is stored as null. */
export type AgentRoleValue = string | null;

export interface AgentRoleDefinition {
	name: string;
	/** A panel role runs one subagent per seat. */
	panel: boolean;
	/** Seats in the bundled default for panel roles; 1 otherwise. */
	defaultSeats: number;
	description: string;
}

export const AGENT_ROLE_BUDGETS: { budget: AgentRoleBudget; label: string; thinking: ThinkingLevel }[] = [
	{ budget: "unlimited", label: "unlimited — xhigh reasoning", thinking: "xhigh" },
	{ budget: "large", label: "large — high reasoning", thinking: "high" },
	{ budget: "medium", label: "medium — medium reasoning", thinking: "medium" },
	{ budget: "small", label: "small — low reasoning", thinking: "low" },
];

const DESCRIPTIONS: Record<string, string> = {
	code: "Default for worker and poteto-agent children",
	judgment: "Default for judgment-heavy children",
	verification: "Default for comment and verification reviewers",
	"feature, refactoring": "Builds features and refactors",
	"bug-fix": "Fixes bugs",
	"perf-issue": "Investigates performance problems",
	hillclimb: "Iterative metric hill-climbing",
	"hardest tasks": "The hardest tasks",
	"judgment and prose": "Judgment calls and writing",
	"how explorer": "/how: explores the code",
	"how explainer": "/how: explains what was found",
	"why investigator": "/why: investigates causes",
	"why synthesizer": "/why: writes the conclusion",
	"teach explainer": "/teach: explains concepts",
	"swarm workers": "/swarm: default model for every worker",
	"arena cross-judge": "/arena: the cross-family judge",
	"reflect synthesizer": "/reflect: combines reviews",
	"architect runners": "/architect: one design per seat",
	"arena runners": "/arena: one candidate per seat",
	"arena cross-judge pool": "/arena: judges to try in order; one runs",
	"interrogate reviewers": "/interrogate: one reviewer per seat",
	"reflect reviewers": "/reflect: one reviewer per seat",
};

const RESERVED = new Set(["schemaVersion", "rules"]);

/** Parse a model-roles.json document: role names in file order, with list values marking panels. */
function parseRoleFile(text: string): Map<string, AgentRoleValue | AgentRoleValue[]> {
	const parsed: unknown = JSON.parse(text);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("model-roles.json must be an object");
	const roles = new Map<string, AgentRoleValue | AgentRoleValue[]>();
	for (const [name, value] of Object.entries(parsed)) {
		if (RESERVED.has(name)) continue;
		if (Array.isArray(value))
			roles.set(
				name,
				value.map((entry) => (typeof entry === "string" ? entry : null)),
			);
		else roles.set(name, typeof value === "string" ? value : null);
	}
	return roles;
}

let bundledCatalog: AgentRoleDefinition[] | undefined;

/** The roles the bundled workflows use, from the bundled agents/model-roles.json. */
export function agentRoleCatalog(): AgentRoleDefinition[] {
	bundledCatalog ??= [
		...parseRoleFile(readFileSync(join(getBundledHarnessPath(), "agents", "model-roles.json"), "utf8")),
	].map(([name, value]) => ({
		name,
		panel: Array.isArray(value),
		defaultSeats: Array.isArray(value) ? Math.max(1, value.length) : 1,
		description: DESCRIPTIONS[name] ?? "",
	}));
	return bundledCatalog;
}

const normalize = (value: unknown): AgentRoleValue =>
	typeof value === "string" && value.trim() && value.trim() !== "inherit" ? value.trim() : null;

/** The effective value of every catalog role: panel roles as a list of seats. */
export function effectiveAgentRoles(
	source: { kind: "settings"; settings: AgentRolesSettings } | { kind: "instance"; resourceRoot: string },
	catalog = agentRoleCatalog(),
): Map<string, AgentRoleValue | AgentRoleValue[]> {
	const configured =
		source.kind === "instance"
			? parseRoleFile(readFileSync(join(source.resourceRoot, "agents", "model-roles.json"), "utf8"))
			: new Map(Object.entries(source.settings.roles ?? {}));
	const roles = new Map<string, AgentRoleValue | AgentRoleValue[]>();
	for (const role of catalog) {
		const value = configured.get(role.name);
		if (role.panel) {
			const seats = Array.isArray(value) ? value.map(normalize) : value === undefined ? [] : [normalize(value)];
			roles.set(role.name, seats.length ? seats : Array.from({ length: role.defaultSeats }, () => null));
		} else {
			roles.set(role.name, normalize(Array.isArray(value) ? value[0] : value));
		}
	}
	// An instance revision may define roles the bundle does not know.
	for (const [name, value] of configured) {
		if (!roles.has(name)) roles.set(name, Array.isArray(value) ? value.map(normalize) : normalize(value));
	}
	return roles;
}

export interface ResolvedAgentRole {
	/** "provider/id", or undefined to use the normal child model. */
	model?: string;
	/** Thinking level from the budget, only when the role names a model. */
	thinking?: ThinkingLevel;
}

/** Resolve one role (and seat, for panel roles) to a model and thinking level. */
export function resolveAgentRole(
	roles: Map<string, AgentRoleValue | AgentRoleValue[]>,
	budget: AgentRoleBudget | undefined,
	name: string,
	seat: number | undefined,
): ResolvedAgentRole {
	if (!roles.has(name)) {
		throw new Error(`Unknown role "${name}". Known roles: ${[...roles.keys()].join(", ")}`);
	}
	const value = roles.get(name);
	let model: AgentRoleValue;
	if (Array.isArray(value)) {
		const index = seat ?? 0;
		if (!Number.isSafeInteger(index) || index < 0 || index >= value.length) {
			throw new Error(
				`Role "${name}" has ${value.length} seat${value.length === 1 ? "" : "s"}; seat must be 0 to ${value.length - 1}`,
			);
		}
		model = value[index] ?? null;
	} else {
		if (seat !== undefined && seat !== 0) throw new Error(`Role "${name}" has one seat; omit seat`);
		model = value ?? null;
	}
	if (!model) return {};
	const thinking = AGENT_ROLE_BUDGETS.find((entry) => entry.budget === budget)?.thinking;
	return thinking ? { model, thinking } : { model };
}
