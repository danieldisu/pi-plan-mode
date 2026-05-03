/**
 * Plan Mode Extension
 *
 * Toggleable read-only mode that blocks write/edit tools.
 * Smart bash filtering with whitelist and AI review.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { completeSimple } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { existsSync, readFileSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const SAFE_COMMAND_PATTERNS: RegExp[] = [
	/^\s*cat\b/,
	/^\s*ls\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*wc\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*git\s+(status|log|diff|show|branch)\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*which\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*date\b/,
];

export const MUTATING_GIT_COMMANDS: RegExp[] = [
	/^\s*git\s+commit/,
	/^\s*git\s+push/,
	/^\s*git\s+pull/,
	/^\s*git\s+merge/,
	/^\s*git\s+rebase/,
	/^\s*git\s+reset/,
	/^\s*git\s+cherry-pick/,
	/^\s*git\s+branch\s+-D/,
	/^\s*git\s+branch\s+-d/,
	/^\s*git\s+tag\s+-d/,
];

// Block dangerous shell constructs (but allow pipes for safe command chaining)
export const UNSAFE_SHELL_CHARS = /[;&`\n]/;
export const REDIRECT_PATTERN = />{1,2}/;

// Patterns for unsafe pipe targets
const UNSAFE_PIPE_PATTERNS: RegExp[] = [
	/\|\s*tee\b/,
	/\|\s*rm\b/,
	/\|\s*xargs.*rm\b/,
	/\|\s*sudo\b/,
	/\|\s*chmod\b/,
	/\|\s*chown\b/,
	/\|\s*mv\b/,
	/\|\s*cp\b/,
	/\|\s*wget\b/,
	/\|\s*curl\b/,
];

export const UNSAFE_WRITE_COMMAND_PATTERNS: RegExp[] = [
	/^\s*tee\b/,
	/\|\s*tee\b/,
	/<<[-]?\s*['"]?\w+['"]?/,
	/\b(python|python3|node|ruby|perl|php)\b[\s\S]*\b(writeFile|writeFileSync|write_text|open\s*\([^)]*,\s*['"][wa+]|File\.write|fs\.write|createWriteStream)\b/,
];

function hasUnsafePipe(command: string): boolean {
	return UNSAFE_PIPE_PATTERNS.some((p) => p.test(command));
}

export function isWhitelisted(command: string): boolean {
	const trimmed = command.trim().replace(/\\\n\s*/g, "").replace(/\n\s*/g, " ");
	if (UNSAFE_SHELL_CHARS.test(trimmed)) return false;
	if (REDIRECT_PATTERN.test(trimmed)) return false;
	if (UNSAFE_WRITE_COMMAND_PATTERNS.some((p) => p.test(trimmed))) return false;
	if (hasUnsafePipe(trimmed)) return false;
	return SAFE_COMMAND_PATTERNS.some((p) => p.test(trimmed));
}

export interface PlanModeConfig {
	defaultPlanStorage?: string;
}

function readConfig(file: string): PlanModeConfig {
	if (!existsSync(file)) return {};
	try {
		return JSON.parse(readFileSync(file, "utf8")) as PlanModeConfig;
	} catch {
		return {};
	}
}

export function getPlanStorageRoot(ctx: Pick<ExtensionContext, "cwd">): string {
	const globalConfig = readConfig(path.join(os.homedir(), ".pi", "agent", "plan-mode.json"));
	const projectConfig = readConfig(path.join(ctx.cwd, ".pi", "plan-mode.json"));
	const configured = process.env.DEFAULT_PLAN_STORAGE
		|| projectConfig.defaultPlanStorage
		|| globalConfig.defaultPlanStorage
		|| path.join(ctx.cwd, "tmp");
	return path.resolve(ctx.cwd, configured);
}

export function safeTimestamp(date = new Date()): string {
	return date.toISOString().replace(/[:.]/g, "-");
}

export function timestampedPlanFilename(date = new Date()): string {
	return `plan-${safeTimestamp(date)}.md`;
}

export async function resolvePlanPath(storageRoot: string, requestedPath?: string): Promise<string> {
	if (requestedPath?.includes("..")) {
		throw new Error("Plan path must not contain '..' traversal segments.");
	}

	const filename = requestedPath || timestampedPlanFilename();
	if (!/\.mdx?$/i.test(filename)) {
		throw new Error("Plan files must use a .md or .mdx extension.");
	}

	const root = path.resolve(storageRoot);
	const target = path.resolve(root, filename);
	const relative = path.relative(root, target);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error("Plan path must stay inside the plan storage root.");
	}

	await fs.mkdir(root, { recursive: true });
	await fs.mkdir(path.dirname(target), { recursive: true });

	const realRoot = await fs.realpath(root);
	let realParent: string;
	try {
		realParent = await fs.realpath(path.dirname(target));
	} catch {
		realParent = path.dirname(target);
	}
	const realRelative = path.relative(realRoot, realParent);
	if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
		throw new Error("Plan path must not escape storage through symlinks.");
	}

	return target;
}

function getBashOverride(entries: any[], command: string): boolean {
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === "plan-mode-bash-override") {
			if (entry.data?.command === command) return true;
		}
	}
	return false;
}

export function hasPlanRequest(args = ""): boolean {
	return args.trim().length > 0;
}

export function formatPlanRequest(args: string): string {
	const request = args.trim();
	return `Plan this request without implementing it yet:

${request}

Explore as needed, identify files to change, and produce a concrete implementation plan. Use save_plan if the plan should be stored. Do not implement changes until plan mode is exited.`;
}

function textFromMessage(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part) => part?.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

export function extractPlanFromText(text: string): string {
	const match = text.match(/(?:^|\n)#{1,3}\s*(?:Implementation\s+Plan|Plan)\s*\n([\s\S]*?)(?=\n#{1,3}\s+\S|$)/i);
	const plan = (match?.[1] || text).trim();
	return plan;
}

export function extractLatestPlan(messages: any[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		const text = textFromMessage(message).trim();
		if (!text) continue;
		return extractPlanFromText(text);
	}
	return undefined;
}

export function formatImplementationPrompt(plan: string): string {
	return `Implement this plan:\n\n${plan}`;
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let pendingNewConversationPlan: string | undefined;

	pi.registerTool({
		name: "save_plan",
		label: "Save Plan",
		description: "Save a Markdown plan file while plan mode is active. Files are constrained to the configured plan storage directory.",
		parameters: Type.Object({
			content: Type.String({ description: "Markdown plan content to save" }),
			path: Type.Optional(Type.String({ description: "Optional relative .md/.mdx path under the plan storage directory" })),
		}) as any,
		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			const storageRoot = getPlanStorageRoot(ctx);
			const target = await resolvePlanPath(storageRoot, params.path);
			await fs.writeFile(target, params.content, "utf8");
			return {
				content: [{ type: "text", text: `Plan saved to ${target}` }],
				details: { path: target, storageRoot },
			};
		},
	});

	function updateStatus(ctx: ExtensionContext): void {
		if (planModeEnabled) {
			ctx.ui.setStatus("plan", ctx.ui.theme.fg("warning", "⚠️ planning"));
		} else {
			ctx.ui.setStatus("plan", undefined);
		}
	}

	function persistState(ctx: ExtensionContext): void {
		pi.appendEntry("plan-mode", {
			active: planModeEnabled,
			timestamp: new Date().toISOString(),
		});
	}

	function restoreNormalTools(): void {
		const allTools = pi.getAllTools?.().map((t) => t.name) || [];
		if (allTools.length > 0) pi.setActiveTools(allTools);
	}

	function setPlanMode(enabled: boolean, ctx: ExtensionContext, notify = true): void {
		planModeEnabled = enabled;
		if (!planModeEnabled) restoreNormalTools();

		if (notify) {
			if (planModeEnabled) {
				ctx.ui.notify("✅ Plan mode enabled - writes blocked", "info");
			} else {
				ctx.ui.notify("✅ Plan mode disabled - writes enabled", "info");
			}
		}

		updateStatus(ctx);
		persistState(ctx);
	}

	pi.registerCommand("plan", {
		description: "Toggle plan mode, or start planning with /plan <request>",
		handler: async (args, ctx) => {
			if (!hasPlanRequest(args)) {
				setPlanMode(!planModeEnabled, ctx);
				return;
			}

			if (!planModeEnabled) {
				setPlanMode(true, ctx);
			} else {
				ctx.ui.notify("i️ Plan mode already active - starting plan", "info");
				updateStatus(ctx);
				persistState(ctx);
			}

			await (pi as any).sendUserMessage(formatPlanRequest(args));
		},
	});

	pi.registerCommand("plan-implement-new", {
		description: "Implement the most recently captured plan-mode plan in a new conversation",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			if (!pendingNewConversationPlan) {
				ctx.ui.notify("No pending plan to implement in a new conversation.", "warning");
				return;
			}
			const plan = pendingNewConversationPlan;
			pendingNewConversationPlan = undefined;
			setPlanMode(false, ctx, false);
			await (ctx as any).newSession({
				withSession: async (newCtx: any) => {
					await newCtx.sendUserMessage(formatImplementationPrompt(plan));
				},
			});
		},
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!planModeEnabled || !ctx.hasUI) return;
		const plan = extractLatestPlan(event.messages);
		if (!plan) return;

		const choice = await ctx.ui.select("Plan complete — what next?", [
			"Exit plan mode and implement here",
			"Implement in a new conversation",
			"Store plan",
			"Stay in plan mode",
		]);

		if (choice === "Exit plan mode and implement here") {
			setPlanMode(false, ctx);
			await (pi as any).sendUserMessage(formatImplementationPrompt(plan));
		} else if (choice === "Implement in a new conversation") {
			pendingNewConversationPlan = plan;
			ctx.ui.notify("Run /plan-implement-new to start a new conversation with this plan.", "info");
		} else if (choice === "Store plan") {
			const storageRoot = getPlanStorageRoot(ctx);
			const target = await resolvePlanPath(storageRoot);
			await fs.writeFile(target, plan, "utf8");
			ctx.ui.notify(`Plan saved to ${target}`, "info");
		}
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (planModeEnabled) {
			// Hide write/edit tools entirely from the agent; save_plan is the only write path.
			pi.setActiveTools(["read", "bash", "save_plan"]);
		} else {
			// Restore all tools
			const allTools = pi.getAllTools().map((t) => t.name);
			pi.setActiveTools(allTools);
		}

		if (!planModeEnabled) return;

		const instructions = `[PLAN MODE ACTIVE]

You are in plan mode. This is a PLANNING PHASE only.

Available tools:
- read: Read files to understand the codebase
- bash: Run commands for exploration (safe commands allowed, others reviewed)
- save_plan: Save Markdown plans under the configured plan storage directory

Note: write and edit tools are disabled in plan mode. save_plan is the only write-capable tool.

Help the user plan what needs to be done:
- Explore the codebase
- Discuss the approach
- Identify files that need changes
- When ready, remind the user to run /plan to exit plan mode`;

		return {
			systemPrompt: _event.systemPrompt + "\n\n" + instructions,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const planEntries = entries.filter(
			(e) => e.type === "custom" && e.customType === "plan-mode",
		);
		const lastEntry = planEntries.length > 0 ? planEntries[planEntries.length - 1] : null;

		if (lastEntry && "data" in lastEntry && (lastEntry as any).data?.active === true) {
			planModeEnabled = true;
			updateStatus(ctx);
			ctx.ui.notify("i️ Plan mode restored", "info");
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!planModeEnabled) return;

		// Block write/edit tools
		if (event.toolName === "write" || event.toolName === "edit") {
			return {
				block: true,
				reason: "Plan mode active. Use /plan to enable write/edit tools.",
			};
		}

		if (event.toolName === "bash") {
			const command = (event.input as any)?.command || "";

			const entries = ctx.sessionManager.getEntries();
			if (getBashOverride(entries, command)) return;

			if (MUTATING_GIT_COMMANDS.some((p) => p.test(command))) {
				return {
					block: true,
					reason: "Plan mode: mutating git commands are not allowed.",
				};
			}

			// Block commands with shell redirects (>, >>) - these write to files
			if (REDIRECT_PATTERN.test(command)) {
				return {
					block: true,
					reason: "Plan mode: file redirects are not allowed.",
				};
			}

			if (UNSAFE_WRITE_COMMAND_PATTERNS.some((p) => p.test(command))) {
				return {
					block: true,
					reason: "Plan mode: write-like shell commands are not allowed. Use save_plan for Markdown plans.",
				};
			}

			if (isWhitelisted(command)) return;

			try {
				const currentModel = ctx.model;
				if (!currentModel) {
					return {
						block: true,
						reason: "Plan mode: cannot review command (no model available).",
					};
				}

				const authResult = await ctx.modelRegistry.getApiKeyAndHeaders(currentModel);
				if (!authResult.ok) {
					return {
						block: true,
						reason: "Plan mode: cannot review command (auth failed).",
					};
				}

				const response = await completeSimple(
					currentModel,
					{
						messages: [
							{
								role: "user",
								content: [
									{
										type: "text",
										text:
											"Is this bash command EXPLORATORY (read-only, safe in plan mode) or MUTATING (writes, deletes, or changes state)?\n\n" +
											`$ ${command}\n\nRespond with a single word: EXPLORATORY or MUTATING`,
									},
								],
								timestamp: Date.now(),
							},
						],
					},
					{ apiKey: authResult.apiKey, headers: authResult.headers, maxTokens: 256 },
				);

				const text = response.content
					.filter((c) => c.type === "text")
					.map((c) => c.text)
					.join(" ")
					.toLowerCase();

				if (text.includes("mutating")) {
					const allowed = await ctx.ui.confirm(
						"Plan mode: command blocked",
						`This command would mutate state:\n\n  $ ${command}\n\nAllow anyway?`,
					);

					if (allowed) {
						pi.appendEntry("plan-mode-bash-override", { command, timestamp: Date.now() });
						return;
					}

					return {
						block: true,
						reason: "Plan mode: command would mutate state. Use /plan to exit plan mode.",
					};
				}

				return;
			} catch (error: any) {
				console.error(`Plan mode AI review failed:`, error);

				const allowed = await ctx.ui.confirm(
					"Plan mode: AI review failed",
					`Could not review command due to error:\n\n  ${error.message}\n\n  $ ${command}\n\nAllow anyway?`,
				);

				if (allowed) {
					pi.appendEntry("plan-mode-bash-override", { command, timestamp: Date.now() });
					return;
				}

				return {
					block: true,
					reason: "Plan mode: AI review failed. Command blocked for safety.",
				};
			}
		}
	});
}
