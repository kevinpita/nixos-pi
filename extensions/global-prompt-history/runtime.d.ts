declare module "node:crypto" {
	type Hash = {
		update(data: string): Hash;
		digest(encoding: "hex"): string;
	};

	export function createHash(algorithm: string): Hash;
}

declare module "node:fs/promises" {
	type WriteFileOptions = {
		readonly encoding?: "utf8";
		readonly mode?: number;
		readonly flag?: string;
	};

	type DirectoryEntry = {
		readonly name: string;
		isDirectory(): boolean;
		isFile(): boolean;
		isSymbolicLink(): boolean;
	};

	type FileHandle = {
		read(
			buffer: Uint8Array,
			offset: number,
			length: number,
			position: null,
		): Promise<{ readonly bytesRead: number }>;
		close(): Promise<void>;
	};

	export function chmod(path: string, mode: number): Promise<void>;
	export function mkdir(
		path: string,
		options?: { readonly recursive?: boolean; readonly mode?: number },
	): Promise<string | undefined>;
	export function open(path: string, flags: "r"): Promise<FileHandle>;
	export function readFile(path: string, encoding: "utf8"): Promise<string>;
	export function readdir(path: string): Promise<string[]>;
	export function readdir(
		path: string,
		options: { readonly withFileTypes: true },
	): Promise<DirectoryEntry[]>;
	export function rename(oldPath: string, newPath: string): Promise<void>;
	export function rm(
		path: string,
		options?: { readonly force?: boolean; readonly recursive?: boolean },
	): Promise<void>;
	export function stat(path: string): Promise<{
		readonly mtimeMs: number;
		readonly size: number;
	}>;
	export function writeFile(
		path: string,
		data: string,
		options?: WriteFileOptions,
	): Promise<void>;
}

declare module "node:os" {
	export function homedir(): string;
}

declare module "node:path" {
	export const sep: string;
	export function basename(path: string, suffix?: string): string;
	export function dirname(path: string): string;
	export function join(...paths: string[]): string;
	export function resolve(...paths: string[]): string;
}

declare module "@earendil-works/pi-coding-agent" {
	type SessionInfo = {
		readonly path: string;
		readonly id: string;
		readonly cwd: string;
		readonly name?: string;
		readonly modified: Date;
	};

	export const SessionManager: {
		listAll(): Promise<SessionInfo[]>;
	};
	export function getAgentDir(): string;
}

declare module "@earendil-works/pi-tui" {
	export class Input {
		focused: boolean;
		getValue(): string;
		setValue(value: string): void;
		handleInput(data: string): void;
		render(width: number): string[];
		invalidate(): void;
	}

	export const Key: {
		ctrl(key: string): string;
	};
	export function fuzzyFilter<T>(
		items: readonly T[],
		query: string,
		getText: (item: T) => string,
	): T[];
	export function matchesKey(data: string, key: string): boolean;
	export function truncateToWidth(
		text: string,
		width: number,
		ellipsis?: string,
	): string;
	export function visibleWidth(text: string): number;
}

declare const process: {
	readonly env: Record<string, string | undefined>;
};
