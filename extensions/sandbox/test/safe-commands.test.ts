import { describe, it, expect } from "vitest";
import { isSafeCommand } from "../src/safe-commands.js";

describe("isSafeCommand", () => {
	describe("safe commands", () => {
		it("allows basic read commands", () => {
			expect(isSafeCommand("ls")).toBe(true);
			expect(isSafeCommand("ls -la")).toBe(true);
			expect(isSafeCommand("cat file.txt")).toBe(true);
			expect(isSafeCommand("head -n 10 file.txt")).toBe(true);
			expect(isSafeCommand("tail -f log.txt")).toBe(true);
			expect(isSafeCommand("grep pattern file")).toBe(true);
			expect(isSafeCommand("pwd")).toBe(true);
			expect(isSafeCommand("echo hello")).toBe(true);
		});

		it("allows safe git commands", () => {
			expect(isSafeCommand("git status")).toBe(true);
			expect(isSafeCommand("git log")).toBe(true);
			expect(isSafeCommand("git diff")).toBe(true);
			expect(isSafeCommand("git show HEAD")).toBe(true);
			expect(isSafeCommand("git branch")).toBe(true);
		});

		it("allows safe cargo commands", () => {
			expect(isSafeCommand("cargo check")).toBe(true);
			expect(isSafeCommand("cargo clippy")).toBe(true);
		});

		it("allows piped safe commands", () => {
			expect(isSafeCommand("ls | wc -l")).toBe(true);
			expect(isSafeCommand("cat file | grep pattern | head")).toBe(true);
		});

		it("allows chained safe commands", () => {
			expect(isSafeCommand("ls && pwd")).toBe(true);
			expect(isSafeCommand("echo hi; ls")).toBe(true);
		});

		it("allows find without dangerous options", () => {
			expect(isSafeCommand("find . -name '*.ts'")).toBe(true);
			expect(isSafeCommand("find /tmp -type f")).toBe(true);
		});

		it("allows sed with -n (print only)", () => {
			expect(isSafeCommand("sed -n '1,10p' file.txt")).toBe(true);
		});
	});

	describe("unsafe commands", () => {
		it("blocks commands with redirections", () => {
			expect(isSafeCommand("echo test > file.txt")).toBe(false);
			expect(isSafeCommand("cat foo >> bar")).toBe(false);
		});

		it("blocks dangerous git commands", () => {
			expect(isSafeCommand("git push")).toBe(false);
			expect(isSafeCommand("git commit")).toBe(false);
			expect(isSafeCommand("git reset --hard")).toBe(false);
			expect(isSafeCommand("git checkout")).toBe(false);
		});

		it("blocks find with dangerous options", () => {
			expect(isSafeCommand("find . -exec rm {} \\;")).toBe(false);
			expect(isSafeCommand("find . -delete")).toBe(false);
		});

		it("blocks sed without -n", () => {
			expect(isSafeCommand("sed 's/a/b/' file")).toBe(false);
		});

		it("blocks rm", () => {
			expect(isSafeCommand("rm file.txt")).toBe(false);
			expect(isSafeCommand("rm -rf /")).toBe(false);
		});

		it("blocks unknown commands", () => {
			expect(isSafeCommand("someunknowncommand")).toBe(false);
		});

		it("blocks chains with unsafe command", () => {
			expect(isSafeCommand("ls && rm -rf /")).toBe(false);
			expect(isSafeCommand("echo hi | tee file.txt")).toBe(false);
		});
	});
});
