export type FencedCodeBlock = {
	readonly language?: string;
	readonly content: string;
};

type OpenFence = {
	readonly marker: "`" | "~";
	readonly length: number;
	readonly language?: string;
	readonly contentLines: string[];
};

function openingFence(line: string): OpenFence | undefined {
	const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
	if (!match) return undefined;

	const fence = match[1];
	const info = match[2].trim();
	if (fence.startsWith("`") && info.includes("`")) return undefined;

	return {
		marker: fence[0] as "`" | "~",
		length: fence.length,
		language: info.split(/\s+/, 1)[0] || undefined,
		contentLines: [],
	};
}

function isClosingFence(line: string, fence: OpenFence): boolean {
	const candidate = line.replace(/^ {0,3}/, "");
	const match = candidate.match(/^(`+|~+)[ \t]*$/);
	return Boolean(
		match && match[1][0] === fence.marker && match[1].length >= fence.length,
	);
}

export function extractFencedCodeBlocks(markdown: string): FencedCodeBlock[] {
	const blocks: FencedCodeBlock[] = [];
	let openFence: OpenFence | undefined;

	for (const line of markdown.split(/\r\n?|\n/)) {
		if (!openFence) {
			openFence = openingFence(line);
			continue;
		}

		if (isClosingFence(line, openFence)) {
			blocks.push({
				language: openFence.language,
				content: openFence.contentLines.join("\n"),
			});
			openFence = undefined;
			continue;
		}

		openFence.contentLines.push(line);
	}

	if (openFence) {
		blocks.push({
			language: openFence.language,
			content: openFence.contentLines.join("\n"),
		});
	}

	return blocks;
}
