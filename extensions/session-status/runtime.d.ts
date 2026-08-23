declare const process: {
	readonly pid: number;
	readonly env: Readonly<Record<string, string | undefined>>;
	getuid(): number;
};

declare module "node:fs" {
	export function mkdirSync(
		path: string,
		options: { readonly recursive: true; readonly mode: number },
	): void;
	export function renameSync(oldPath: string, newPath: string): void;
	export function unlinkSync(path: string): void;
	export function writeFileSync(
		path: string,
		data: string,
		options: { readonly encoding: "utf8"; readonly mode: number },
	): void;
}

declare module "node:path" {
	export function basename(path: string): string;
	export function join(...paths: string[]): string;
}
