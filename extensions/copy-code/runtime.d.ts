type CopyCodeTheme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

declare module "@earendil-works/pi-coding-agent" {
	export function copyToClipboard(text: string): Promise<void>;
	export function highlightCode(
		code: string,
		language: string,
		theme: CopyCodeTheme,
	): string;
}

declare module "@earendil-works/pi-tui" {
	export function truncateToWidth(
		text: string,
		width: number,
		ellipsis?: string,
		pad?: boolean,
	): string;
	export function visibleWidth(text: string): number;
}
