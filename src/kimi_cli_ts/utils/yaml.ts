/**
 * Minimal YAML parser utility.
 * For agent spec YAML files which use simple structures.
 *
 * For production use, consider adding `yaml` package.
 * This is a bootstrap implementation.
 */
export function parse(text: string): unknown {
	const lines = text.split("\n");
	return parseObject(lines, 0).value;
}

interface ParseResult {
	value: unknown;
	consumed: number;
}

function parseObject(lines: string[], startIndent: number): ParseResult {
	const obj: Record<string, unknown> = {};
	let i = 0;

	while (i < lines.length) {
		const line = lines[i]!;
		const stripped = line.trimStart();

		if (!stripped || stripped.startsWith("#")) {
			i++;
			continue;
		}

		const indent = line.length - stripped.length;
		if (indent < startIndent) break;

		if (stripped.startsWith("- ")) break;

		const colonIdx = stripped.indexOf(":");
		if (colonIdx === -1) {
			i++;
			continue;
		}

		const key = stripped.slice(0, colonIdx).trim();
		const valueStr = stripped.slice(colonIdx + 1).trim();

		if (valueStr === "" || valueStr === "|" || valueStr === ">") {
			i++;
			const nextIndent = getNextIndent(lines, i);
			if (nextIndent > indent) {
				const nextStripped = (lines[i] ?? "").trimStart();
				if (nextStripped.startsWith("- ")) {
					const arr = parseArray(lines.slice(i), nextIndent);
					obj[key] = arr.value;
					i += arr.consumed;
				} else if (valueStr === "|" || valueStr === ">") {
					const block = parseBlockScalar(
						lines.slice(i),
						nextIndent,
						valueStr === "|",
					);
					obj[key] = block.value;
					i += block.consumed;
				} else {
					const nested = parseObject(lines.slice(i), nextIndent);
					obj[key] = nested.value;
					i += nested.consumed;
				}
			} else {
				obj[key] = null;
			}
		} else {
			obj[key] = parseScalar(valueStr);
			i++;
		}
	}

	return { value: obj, consumed: i };
}

function parseArray(lines: string[], startIndent: number): ParseResult {
	const arr: unknown[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i]!;
		const stripped = line.trimStart();
		if (!stripped || stripped.startsWith("#")) {
			i++;
			continue;
		}

		const indent = line.length - stripped.length;
		if (indent < startIndent) break;

		if (stripped.startsWith("- ")) {
			const itemStr = stripped.slice(2).trim();
			if (itemStr.includes(":")) {
				const colonIdx = itemStr.indexOf(":");
				const key = itemStr.slice(0, colonIdx).trim();
				const val = itemStr.slice(colonIdx + 1).trim();

				i++;
				const nextIndent = getNextIndent(lines, i);
				if (nextIndent > indent + 2) {
					const nested = parseObject(lines.slice(i), nextIndent);
					const item: Record<string, unknown> = {
						[key]: val ? parseScalar(val) : nested.value,
					};
					if (
						typeof nested.value === "object" &&
						nested.value !== null &&
						!val
					) {
						Object.assign(item, { [key]: nested.value });
					}
					arr.push(item);
					i += nested.consumed;
				} else {
					arr.push({ [key]: parseScalar(val) });
				}
			} else {
				arr.push(parseScalar(itemStr));
				i++;
			}
		} else {
			break;
		}
	}

	return { value: arr, consumed: i };
}

function parseBlockScalar(
	lines: string[],
	startIndent: number,
	literal: boolean,
): ParseResult {
	const parts: string[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i]!;
		const stripped = line.trimStart();
		const indent = line.length - stripped.length;

		if (!stripped) {
			parts.push("");
			i++;
			continue;
		}

		if (indent < startIndent) break;
		parts.push(line.slice(startIndent));
		i++;
	}

	const sep = literal ? "\n" : " ";
	return { value: parts.join(sep).trimEnd(), consumed: i };
}

function getNextIndent(lines: string[], from: number): number {
	for (let i = from; i < lines.length; i++) {
		const line = lines[i]!;
		const stripped = line.trimStart();
		if (stripped && !stripped.startsWith("#")) {
			return line.length - stripped.length;
		}
	}
	return 0;
}

function parseScalar(value: string): unknown {
	if (!value) return null;

	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}

	if (value === "true" || value === "True" || value === "yes") return true;
	if (value === "false" || value === "False" || value === "no") return false;
	if (value === "null" || value === "~" || value === "Null") return null;

	if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
	if (/^-?\d+\.\d+$/.test(value)) return Number.parseFloat(value);

	if (value.startsWith("[") && value.endsWith("]")) {
		return value
			.slice(1, -1)
			.split(",")
			.map((s) => parseScalar(s.trim()));
	}

	return value;
}
