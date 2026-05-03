/**
 * Tests for plan-mode extension whitelist functionality.
 * 
 * These tests document the current bugs where safe commands are incorrectly blocked.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import planModeExtension, { formatPlanRequest, hasPlanRequest, isWhitelisted, resolvePlanPath } from "./plan-mode.js";

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
	function setupCommand() {
		let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
		const pi = {
			registerTool: vi.fn(),
			registerCommand: vi.fn((_name, config) => {
				handler = config.handler;
			}),
			on: vi.fn(),
			appendEntry: vi.fn(),
			sendUserMessage: vi.fn(),
		} as any;
		const ctx = {
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
