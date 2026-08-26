import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BiomeClient } from "../src/lsp/clients/biome-client";
import type { ServerConfig } from "../src/lsp/types";

const tempDirs: string[] = [];
const tempRoots: string[] = [];
const repoRoot = path.resolve(import.meta.dir, "../../..");

function resolveRepoBiome(): string {
	const platformPackages: Partial<Record<NodeJS.Platform, Partial<Record<NodeJS.Architecture, string[]>>>> = {
		darwin: { arm64: ["cli-darwin-arm64"], x64: ["cli-darwin-x64"] },
		linux: {
			arm64: ["cli-linux-arm64", "cli-linux-arm64-musl"],
			x64: ["cli-linux-x64", "cli-linux-x64-musl"],
		},
		win32: { arm64: ["cli-win32-arm64"], x64: ["cli-win32-x64"] },
	};
	const executable = process.platform === "win32" ? "biome.exe" : "biome";
	for (const packageName of platformPackages[process.platform]?.[process.arch] ?? []) {
		try {
			return Bun.resolveSync(`@biomejs/${packageName}/${executable}`, repoRoot);
		} catch {}
	}
	throw new Error(`No repository Biome binary for ${process.platform}/${process.arch}`);
}

const repoBiome = resolveRepoBiome();

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { force: true, recursive: true })));
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { force: true, recursive: true })));
});

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oms-biome-client-test-"));
	tempDirs.push(dir);
	return dir;
}

function biomeConfig(command: string): ServerConfig {
	return {
		command: "biome",
		fileTypes: [".ts"],
		rootMarkers: [],
		resolvedCommand: command,
	};
}

describe("BiomeClient format", () => {
	test("formats the supplied content instead of stale on-disk content", async () => {
		const tempDir = await fs.mkdtemp(
			path.join(repoRoot, "packages", "coding-agent", "src", "__biome_content_test__-"),
		);
		tempDirs.push(tempDir);
		const targetFile = path.join(tempDir, "example.ts");
		const unformatted = "export const value:number=1\n";
		const formatted = "export const value: number = 1;\n";
		await Bun.write(targetFile, "export const stale = true;\n");
		const result = await new BiomeClient(biomeConfig(repoBiome), repoRoot).format(targetFile, unformatted);

		expect(result).toBe(formatted);
		expect(await Bun.file(targetFile).text()).toBe(formatted);
	});

	test("formats configured TypeScript with the repository Biome", async () => {
		const scratchDir = await fs.mkdtemp(
			path.join(repoRoot, "packages", "coding-agent", "src", "__biome_client_test__-"),
		);
		tempDirs.push(scratchDir);
		const targetFile = path.join(scratchDir, "configured.ts");
		const unformatted = "export const configured:number=1\n";
		await Bun.write(targetFile, unformatted);

		const result = await new BiomeClient(biomeConfig(repoBiome), repoRoot).format(targetFile, unformatted);

		expect(result).toBe("export const configured: number = 1;\n");
	});

	test("leaves config-excluded content unchanged with the repository Biome", async () => {
		const excludedRoot = path.join(repoRoot, ".perf");
		const createdRoot = await fs.mkdir(excludedRoot, { recursive: true });
		if (createdRoot) tempRoots.push(excludedRoot);
		const scratchDir = await fs.mkdtemp(path.join(excludedRoot, "biome-client-test-"));
		tempDirs.push(scratchDir);
		const targetFile = path.join(scratchDir, "excluded.ts");
		const unformatted = "export const excluded:number=1\n";
		await Bun.write(targetFile, unformatted);

		const result = await new BiomeClient(biomeConfig(repoBiome), repoRoot).format(targetFile, unformatted);

		expect(result).toBe(unformatted);
	});

	test("returns the original content when Biome fails", async () => {
		const tempDir = await makeTempDir();
		const command = path.join(tempDir, "missing-biome");
		const targetFile = path.join(tempDir, "example.ts");
		const content = "export const value = 1;\n";

		const result = await new BiomeClient(biomeConfig(command), tempDir).format(targetFile, content);

		expect(result).toBe(content);
	});
});
