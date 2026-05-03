/**
 * Tests for plan-mode extension whitelist functionality.
 * 
 * These tests document the current bugs where safe commands are incorrectly blocked.
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import planModeExtension, {
	extractLatestPlan,
	formatPlanRequest,
	getConfiguredThinkingLevel,
	getPlanStorageRoot,
	hasPlanRequest,
	isWhitelisted,
	loadPlanModeConfig,
	resolvePlanPath,
	timestampedPlanFilename,
} from "./plan-mode.js";

describe("plan request helpers", () => {
	it("detects non-whitespace plan requests", () => {
		expect(hasPlanRequest("update this extension")).toBe(true);
		expect(hasPlanRequest("  update this extension  ")).toBe(true);
		expect(hasPlanRequest("   ")).toBe(false);
		expect(hasPlanRequest()).toBe(false);
	});

	it("formats a planning-only user message with the original request", () => {
		const message = formatPlanRequest("  how to update this extension  ");

		expect(message).toContain("Plan this request without implementing it yet:");
		expect(message).toContain("how to update this extension");
		expect(message).toContain("Do not implement changes until plan mode is exited.");
		expect(message).not.toContain("/plan");
	});
});

describe("plan command", () => {
	function setupCommand(cwd = process.cwd()) {
		let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
		const pi = {
			registerTool: vi.fn(),
			registerCommand: vi.fn((name, config) => {
				if (name === "plan") handler = config.handler;
			}),
			on: vi.fn(),
			appendEntry: vi.fn(),
			sendUserMessage: vi.fn(),
			getThinkingLevel: vi.fn(() => "medium"),
			setThinkingLevel: vi.fn(),
			getAllTools: vi.fn(() => []),
			setActiveTools: vi.fn(),
		} as any;
		const ctx = {
			cwd,
			ui: {
				notify: vi.fn(),
				setStatus: vi.fn(),
				theme: { fg: vi.fn((_name, text) => text) },
			},
		} as any;

		planModeExtension(pi);
		if (!handler) throw new Error("plan command was not registered");
		return { pi, ctx, handler };
	}

	it("toggles only and does not send a user message without args", async () => {
		const { pi, ctx, handler } = setupCommand();

		await handler("   ", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("✅ Plan mode enabled - writes blocked", "info");
		expect(pi.appendEntry).toHaveBeenCalledWith("plan-mode", expect.objectContaining({ active: true }));
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("preserves thinking level when no thinking config is set", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-plan-cwd-"));
		try {
			const { pi, handler } = setupCommand(cwd);
			await handler("", { cwd, ui: { notify: vi.fn(), setStatus: vi.fn(), theme: { fg: vi.fn((_name, text) => text) } } });

			expect(pi.setThinkingLevel).not.toHaveBeenCalled();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("enables plan mode and sends a planning request with args", async () => {
		const { pi, ctx, handler } = setupCommand();

		await handler("something to plan", ctx);

		expect(pi.appendEntry).toHaveBeenCalledWith("plan-mode", expect.objectContaining({ active: true }));
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("something to plan"));
	});

	it("does not disable plan mode when already active and args are provided", async () => {
		const { pi, ctx, handler } = setupCommand();
		await handler("", ctx);
		vi.clearAllMocks();

		await handler("next plan", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("i️ Plan mode already active - starting plan", "info");
		expect(pi.appendEntry).toHaveBeenCalledWith("plan-mode", expect.objectContaining({ active: true }));
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
	});

	it("applies configured thinking on enable and restores previous thinking on disable", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-plan-cwd-"));
		try {
			await mkdir(path.join(cwd, ".pi"), { recursive: true });
			await writeFile(path.join(cwd, ".pi", "plan-mode.json"), JSON.stringify({ defaultThinkingLevel: "high" }));
			const { pi, handler } = setupCommand(cwd);

			await handler("", { cwd, ui: { notify: vi.fn(), setStatus: vi.fn(), theme: { fg: vi.fn((_name, text) => text) } } });
			await handler("", { cwd, ui: { notify: vi.fn(), setStatus: vi.fn(), theme: { fg: vi.fn((_name, text) => text) } } });

			expect(pi.setThinkingLevel).toHaveBeenNthCalledWith(1, "high");
			expect(pi.setThinkingLevel).toHaveBeenNthCalledWith(2, "medium");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

describe("plan-mode whitelist", () => {
	describe("commands without trailing space", () => {
		it("should whitelist ls alone", () => {
			expect(isWhitelisted("ls")).toBe(true);
		});

		it("should whitelist git log", () => {
			expect(isWhitelisted("git log")).toBe(true);
		});

		it("should whitelist git status", () => {
			expect(isWhitelisted("git status")).toBe(true);
		});

		it("should whitelist git diff", () => {
			expect(isWhitelisted("git diff")).toBe(true);
		});

		it("should whitelist git show", () => {
			expect(isWhitelisted("git show")).toBe(true);
		});

		it("should whitelist git branch", () => {
			expect(isWhitelisted("git branch")).toBe(true);
		});
	});

	describe("safe pipe operations", () => {
		it("should whitelist ls piped to grep", () => {
			expect(isWhitelisted("ls -la | grep test")).toBe(true);
		});

		it("should whitelist find piped to wc", () => {
			expect(isWhitelisted("find . -name '*.ts' | wc -l")).toBe(true);
		});

		it("should whitelist cat piped to grep", () => {
			expect(isWhitelisted("cat file.ts | grep pattern")).toBe(true);
		});

		it("should whitelist find piped to grep", () => {
			expect(isWhitelisted("find . -type f | grep .ts$")).toBe(true);
		});
	});

	describe("commands that should work (baseline)", () => {
		it("should whitelist pwd", () => {
			expect(isWhitelisted("pwd")).toBe(true);
		});

		it("should whitelist env", () => {
			expect(isWhitelisted("env")).toBe(true);
		});

		it("should whitelist ls with flags", () => {
			expect(isWhitelisted("ls -la")).toBe(true);
		});

		it("should whitelist grep with arguments", () => {
			expect(isWhitelisted("grep pattern file.ts")).toBe(true);
		});

		it("should whitelist cat with file", () => {
			expect(isWhitelisted("cat file.ts")).toBe(true);
		});
	});

	describe("commands that should be blocked", () => {
		it("should block file redirects", () => {
			expect(isWhitelisted("cat file > output")).toBe(false);
		});

		it("should block append redirects", () => {
			expect(isWhitelisted("echo test >> file")).toBe(false);
		});

		it("should block command substitution", () => {
			expect(isWhitelisted("rm $(find . -name '*.log')")).toBe(false);
		});

		it("should block semicolon commands", () => {
			expect(isWhitelisted("ls; rm -rf .")).toBe(false);
		});

		it("should block unsafe pipe to rm", () => {
			// This should be blocked - piping to rm is dangerous
			expect(isWhitelisted("find . -name '*.log' | xargs rm")).toBe(false);
		});

		it("should block tee writes", () => {
			expect(isWhitelisted("tee plan.md")).toBe(false);
			expect(isWhitelisted("echo test | tee plan.md")).toBe(false);
		});

		it("should block heredocs", () => {
			expect(isWhitelisted("cat <<EOF")).toBe(false);
		});

		it("should block runtime scripting writes", () => {
			expect(isWhitelisted("python -c \"from pathlib import Path; Path('x').write_text('y')\"")).toBe(false);
			expect(isWhitelisted("node -e \"require('fs').writeFileSync('x','y')\"")).toBe(false);
		});
	});
});

describe("post-plan actions", () => {
	function setupAgentEnd(choice: string) {
		let agentEnd: ((event: any, ctx: any) => Promise<void>) | undefined;
		let sessionStart: ((event: any, ctx: any) => Promise<void>) | undefined;
		const pi = {
			registerTool: vi.fn(),
			registerCommand: vi.fn(),
			on: vi.fn((name, handler) => {
				if (name === "agent_end") agentEnd = handler;
				if (name === "session_start") sessionStart = handler;
			}),
			appendEntry: vi.fn(),
			sendUserMessage: vi.fn(),
			getThinkingLevel: vi.fn(() => "medium"),
			setThinkingLevel: vi.fn(),
			getAllTools: vi.fn(() => []),
			setActiveTools: vi.fn(),
		} as any;
		const eventCtx = {
			cwd: process.cwd(),
			hasUI: true,
			sessionManager: { getEntries: vi.fn(() => []) },
			ui: {
				select: vi.fn(async () => choice),
				notify: vi.fn(),
				setStatus: vi.fn(),
				theme: { fg: vi.fn((_name, text) => text) },
			},
		} as any;
		const newSessionCtx = { sendUserMessage: vi.fn() };
		const commandCtx = {
			...eventCtx,
			sessionManager: { getSessionFile: vi.fn(() => "/tmp/parent-session.jsonl") },
			newSession: vi.fn(async ({ withSession }) => {
				await withSession(newSessionCtx);
				return { cancelled: false };
			}),
		} as any;

		planModeExtension(pi);
		const planHandler = pi.registerCommand.mock.calls.find(([name]: [string]) => name === "plan")?.[1].handler;
		if (!agentEnd || !planHandler || !sessionStart) throw new Error("handlers were not registered");
		return { pi, eventCtx, commandCtx, newSessionCtx, agentEnd, planHandler, sessionStart };
	}

	it("starts a new conversation from the saved command context when selected from the plan completion menu", async () => {
		vi.useFakeTimers();
		try {
			const { eventCtx, commandCtx, newSessionCtx, agentEnd, planHandler } = setupAgentEnd("Implement in a new conversation");
			await planHandler("", commandCtx);

			await agentEnd({ messages: [{ role: "assistant", content: "## Plan\n- Do thing" }] }, eventCtx);
			await vi.runAllTimersAsync();

			expect(commandCtx.newSession).toHaveBeenCalledOnce();
			expect(commandCtx.newSession).toHaveBeenCalledWith(expect.objectContaining({ parentSession: "/tmp/parent-session.jsonl" }));
			expect(newSessionCtx.sendUserMessage).toHaveBeenCalledWith("Implement this plan:\n\n- Do thing");
			expect(eventCtx.ui.notify).not.toHaveBeenCalledWith(
				"Run /plan-implement-new to start a new conversation with this plan.",
				"info",
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("falls back to /plan-implement-new when no command context is available", async () => {
		const { eventCtx, commandCtx, agentEnd, sessionStart } = setupAgentEnd("Implement in a new conversation");
		eventCtx.sessionManager.getEntries.mockReturnValue([
			{ type: "custom", customType: "plan-mode", data: { active: true } },
		]);
		await sessionStart({}, eventCtx);

		await agentEnd({ messages: [{ role: "assistant", content: "## Plan\n- Do thing" }] }, eventCtx);

		expect(commandCtx.newSession).not.toHaveBeenCalled();
		expect(eventCtx.ui.notify).toHaveBeenCalledWith(
			"Run /plan-implement-new to start a new conversation with this plan.",
			"info",
		);
	});
});

describe("plan extraction", () => {
	it("extracts the latest assistant plan from a Plan heading", () => {
		const plan = extractLatestPlan([
			{ role: "assistant", content: [{ type: "text", text: "Intro\n\n## Plan\n- Do thing\n\n## Notes\nOther" }] },
		]);

		expect(plan).toBe("- Do thing");
	});

	it("falls back to the full latest assistant text", () => {
		expect(extractLatestPlan([{ role: "assistant", content: "No heading here" }])).toBe("No heading here");
	});
});

describe("plan mode config", () => {
	it("loads global config and lets project config override it", async () => {
		const home = await mkdtemp(path.join(tmpdir(), "pi-plan-home-"));
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-plan-cwd-"));
		try {
			await mkdir(path.join(home, ".pi", "agent"), { recursive: true });
			await mkdir(path.join(cwd, ".pi"), { recursive: true });
			await writeFile(path.join(home, ".pi", "agent", "plan-mode.json"), JSON.stringify({
				defaultThinkingLevel: "low",
				restoreThinkingLevel: true,
			}));
			await writeFile(path.join(cwd, ".pi", "plan-mode.json"), JSON.stringify({ defaultThinkingLevel: "high" }));

			const config = loadPlanModeConfig(cwd, home);
			expect(config.defaultThinkingLevel).toBe("high");
			expect(config.restoreThinkingLevel).toBe(true);
			expect(getConfiguredThinkingLevel(config)).toBe("high");
		} finally {
			await rm(home, { recursive: true, force: true });
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("loads global Pi settings planMode config", async () => {
		const home = await mkdtemp(path.join(tmpdir(), "pi-plan-home-"));
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-plan-cwd-"));
		try {
			await mkdir(path.join(home, ".pi", "agent"), { recursive: true });
			await writeFile(path.join(home, ".pi", "agent", "settings.json"), JSON.stringify({
				planMode: { defaultThinkingLevel: "medium", restoreThinkingLevel: false },
			}));

			const config = loadPlanModeConfig(cwd, home);
			expect(config.defaultThinkingLevel).toBe("medium");
			expect(config.restoreThinkingLevel).toBe(false);
		} finally {
			await rm(home, { recursive: true, force: true });
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("lets project Pi settings override global Pi settings", async () => {
		const home = await mkdtemp(path.join(tmpdir(), "pi-plan-home-"));
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-plan-cwd-"));
		try {
			await mkdir(path.join(home, ".pi", "agent"), { recursive: true });
			await mkdir(path.join(cwd, ".pi"), { recursive: true });
			await writeFile(path.join(home, ".pi", "agent", "settings.json"), JSON.stringify({
				planMode: { defaultThinkingLevel: "low", restoreThinkingLevel: true },
			}));
			await writeFile(path.join(cwd, ".pi", "settings.json"), JSON.stringify({
				planMode: { defaultThinkingLevel: "high" },
			}));

			const config = loadPlanModeConfig(cwd, home);
			expect(config.defaultThinkingLevel).toBe("high");
			expect(config.restoreThinkingLevel).toBe(true);
		} finally {
			await rm(home, { recursive: true, force: true });
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("ignores invalid thinking levels", async () => {
		const home = await mkdtemp(path.join(tmpdir(), "pi-plan-home-"));
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-plan-cwd-"));
		try {
			await mkdir(path.join(cwd, ".pi"), { recursive: true });
			await writeFile(path.join(cwd, ".pi", "settings.json"), JSON.stringify({
				planMode: { defaultThinkingLevel: "extreme" },
			}));
			const config = loadPlanModeConfig(cwd, home);
			expect(config.defaultThinkingLevel).toBeUndefined();
			expect(getConfiguredThinkingLevel(config)).toBeUndefined();
		} finally {
			await rm(home, { recursive: true, force: true });
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("supports defaultThinkingEffort as an alias", async () => {
		const home = await mkdtemp(path.join(tmpdir(), "pi-plan-home-"));
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-plan-cwd-"));
		try {
			await mkdir(path.join(cwd, ".pi"), { recursive: true });
			await writeFile(path.join(cwd, ".pi", "settings.json"), JSON.stringify({
				planMode: { defaultThinkingEffort: "xhigh" },
			}));
			const config = loadPlanModeConfig(cwd, home);
			expect(getConfiguredThinkingLevel(config)).toBe("xhigh");
		} finally {
			await rm(home, { recursive: true, force: true });
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("keeps project legacy plan-mode config highest precedence", async () => {
		const home = await mkdtemp(path.join(tmpdir(), "pi-plan-home-"));
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-plan-cwd-"));
		try {
			await mkdir(path.join(home, ".pi", "agent"), { recursive: true });
			await mkdir(path.join(cwd, ".pi"), { recursive: true });
			await writeFile(path.join(home, ".pi", "agent", "settings.json"), JSON.stringify({ planMode: { defaultThinkingLevel: "low" } }));
			await writeFile(path.join(home, ".pi", "agent", "plan-mode.json"), JSON.stringify({ defaultThinkingLevel: "medium" }));
			await writeFile(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ planMode: { defaultThinkingLevel: "high" } }));
			await writeFile(path.join(cwd, ".pi", "plan-mode.json"), JSON.stringify({ defaultThinkingLevel: "xhigh" }));

			const config = loadPlanModeConfig(cwd, home);
			expect(getConfiguredThinkingLevel(config)).toBe("xhigh");
		} finally {
			await rm(home, { recursive: true, force: true });
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

describe("plan storage resolution", () => {
	const originalEnv = process.env.DEFAULT_PLAN_STORAGE;
	afterEach(() => {
		if (originalEnv === undefined) delete process.env.DEFAULT_PLAN_STORAGE;
		else process.env.DEFAULT_PLAN_STORAGE = originalEnv;
	});

	it("uses DEFAULT_PLAN_STORAGE before config files", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-plan-cwd-"));
		try {
			process.env.DEFAULT_PLAN_STORAGE = "env-plans";
			expect(getPlanStorageRoot({ cwd } as any)).toBe(path.join(cwd, "env-plans"));
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("uses project config and resolves relative paths against cwd", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-plan-cwd-"));
		try {
			delete process.env.DEFAULT_PLAN_STORAGE;
			await mkdir(path.join(cwd, ".pi"), { recursive: true });
			await writeFile(path.join(cwd, ".pi", "plan-mode.json"), JSON.stringify({ defaultPlanStorage: "plans" }));
			expect(getPlanStorageRoot({ cwd } as any)).toBe(path.join(cwd, "plans"));
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("defaults to cwd tmp storage", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-plan-cwd-"));
		try {
			delete process.env.DEFAULT_PLAN_STORAGE;
			expect(getPlanStorageRoot({ cwd } as any)).toBe(path.join(cwd, "tmp"));
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("sanitizes timestamped filenames", () => {
		const filename = timestampedPlanFilename(new Date("2026-05-03T12:34:56.789Z"));
		expect(filename).toBe("plan-2026-05-03T12-34-56-789Z.md");
		expect(path.basename(filename, ".md")).not.toMatch(/[:.]/);
	});
});

describe("save_plan path resolution", () => {
	it("allows markdown files in the storage root", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "pi-plan-mode-"));
		try {
			const target = await resolvePlanPath(root, "plans/test.md");
			expect(target).toBe(path.resolve(root, "plans/test.md"));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("generates a markdown filename by default", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "pi-plan-mode-"));
		try {
			const target = await resolvePlanPath(root);
			expect(path.dirname(target)).toBe(path.resolve(root));
			expect(path.basename(target)).toMatch(/^plan-.*\.md$/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects traversal and non-markdown paths", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "pi-plan-mode-"));
		try {
			await expect(resolvePlanPath(root, "../escape.md")).rejects.toThrow(/traversal/);
			await expect(resolvePlanPath(root, "plan.txt")).rejects.toThrow(/\.md/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects symlinks that escape the storage root", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "pi-plan-mode-"));
		const outside = await mkdtemp(path.join(tmpdir(), "pi-plan-outside-"));
		try {
			await symlink(outside, path.join(root, "link"));
			await expect(resolvePlanPath(root, "link/escape.md")).rejects.toThrow(/symlinks/);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	});
});
