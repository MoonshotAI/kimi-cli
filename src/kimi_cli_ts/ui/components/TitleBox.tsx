/**
 * TitleBox.tsx — Box with a title riding on the top border.
 *
 * Renders an ink `<Box>` with native borderStyle for left/right/bottom,
 * and a custom top border line with the title embedded:
 *
 *   ╭─ TITLE ────────────────────────────╮
 *   │ content                            │
 *   ╰───────────────────────────────────╯
 *
 * Uses `measureElement` to match the top line width to the actual
 * computed Box width from Yoga layout.
 *
 * Drop-in replacement for `<Box borderStyle="round">` — just add `title`.
 */

import React, { useRef, useState, useLayoutEffect } from "react";
import { Box, Text, measureElement, type DOMElement } from "ink";

// ── Border character sets ───────────────────────────────

const BORDER_CHARS = {
	round: { tl: "╭", tr: "╮", h: "─", bl: "╰", br: "╯", v: "│" },
	single: { tl: "┌", tr: "┐", h: "─", bl: "└", br: "┘", v: "│" },
	bold: { tl: "┏", tr: "┓", h: "━", bl: "┗", br: "┛", v: "┃" },
	double: { tl: "╔", tr: "╗", h: "═", bl: "╚", br: "╝", v: "║" },
	singleDouble: { tl: "╓", tr: "╖", h: "─", bl: "╙", br: "╜", v: "║" },
	doubleSingle: { tl: "╒", tr: "╕", h: "═", bl: "╘", br: "╛", v: "│" },
	classic: { tl: "+", tr: "+", h: "-", bl: "+", br: "+", v: "|" },
} as const;

type BorderStyleName = keyof typeof BORDER_CHARS;

// ── Props ───────────────────────────────────────────────

export interface TitleBoxProps {
	/** Title text displayed on the top border. If omitted, renders a plain Box. */
	title?: string;
	/** Color for the title text. Defaults to borderColor. */
	titleColor?: string;
	/** Border color (applied to all sides). */
	borderColor?: string;
	/** Border style name. Default: "round". */
	borderStyle?: BorderStyleName;
	/** Title alignment within the top border. Default: "left". */
	titleAlign?: "left" | "center";

	// ── Pass-through Box layout props ──
	flexDirection?: "row" | "column" | "row-reverse" | "column-reverse";
	paddingX?: number;
	paddingY?: number;
	padding?: number;
	paddingTop?: number;
	paddingBottom?: number;
	paddingLeft?: number;
	paddingRight?: number;
	width?: number | string;
	height?: number | string;
	minWidth?: number | string;
	minHeight?: number | string;
	flexGrow?: number;
	flexShrink?: number;
	gap?: number;
	alignItems?: "flex-start" | "center" | "flex-end" | "stretch";
	justifyContent?:
		| "flex-start"
		| "flex-end"
		| "space-between"
		| "space-around"
		| "space-evenly"
		| "center";
	overflow?: "visible" | "hidden";
	overflowX?: "visible" | "hidden";
	overflowY?: "visible" | "hidden";
	marginTop?: number;
	marginBottom?: number;
	marginLeft?: number;
	marginRight?: number;
	marginX?: number;
	marginY?: number;
	margin?: number;

	children?: React.ReactNode;
}

// ── Component ───────────────────────────────────────────

export function TitleBox({
	title,
	titleColor,
	borderColor,
	borderStyle = "round",
	titleAlign = "left",
	children,
	// Separate margin props (go on outer wrapper) from inner props
	margin,
	marginX,
	marginY,
	marginTop,
	marginBottom,
	marginLeft,
	marginRight,
	...innerProps
}: TitleBoxProps) {
	const marginProps = {
		margin,
		marginX,
		marginY,
		marginTop,
		marginBottom,
		marginLeft,
		marginRight,
	};

	// No title — just render a standard Box
	if (!title) {
		return (
			<Box
				borderStyle={borderStyle}
				borderColor={borderColor}
				{...marginProps}
				{...innerProps}
			>
				{children}
			</Box>
		);
	}

	const chars = BORDER_CHARS[borderStyle];
	const effectiveTitleColor = titleColor ?? borderColor;

	// Ref to measure the bordered box's computed width
	const boxRef = useRef<DOMElement>(null);
	const [boxWidth, setBoxWidth] = useState(0);

	useLayoutEffect(() => {
		if (boxRef.current) {
			const { width } = measureElement(boxRef.current);
			if (width !== boxWidth) {
				setBoxWidth(width);
			}
		}
	});

	// Build the top border line with embedded title
	// Total width = boxWidth (includes the 2 border chars for left/right)
	// Inner width = boxWidth - 2 (left border + right border)
	const innerWidth = Math.max(0, boxWidth - 2);
	const titleStr = ` ${title} `;
	const titleLen = titleStr.length;

	let topLine: React.ReactNode;
	if (boxWidth > 0) {
		const available = Math.max(0, innerWidth - titleLen);
		let dashesLeft: number;
		let dashesRight: number;

		if (titleAlign === "center") {
			dashesLeft = Math.floor(available / 2);
			dashesRight = available - dashesLeft;
		} else {
			// Left-aligned: small left padding (1 dash), rest on right
			dashesLeft = Math.min(1, available);
			dashesRight = Math.max(0, available - dashesLeft);
		}

		topLine = (
			<Text>
				<Text color={borderColor}>
					{chars.tl}
					{chars.h.repeat(dashesLeft)}
				</Text>
				<Text color={effectiveTitleColor} bold>
					{titleStr}
				</Text>
				<Text color={borderColor}>
					{chars.h.repeat(dashesRight)}
					{chars.tr}
				</Text>
			</Text>
		);
	} else {
		// Before measurement: render a placeholder top line that will be replaced
		topLine = (
			<Text color={borderColor}>
				{chars.tl}
				{chars.h}{" "}
				<Text color={effectiveTitleColor} bold>
					{title}
				</Text>{" "}
				{chars.h}
				{chars.tr}
			</Text>
		);
	}

	return (
		<Box flexDirection="column" {...marginProps}>
			{/* Custom top border with title */}
			{topLine}

			{/* Box with native left/right/bottom borders, no top border */}
			<Box
				ref={boxRef}
				borderStyle={borderStyle}
				borderColor={borderColor}
				borderTop={false}
				{...innerProps}
			>
				{children}
			</Box>
		</Box>
	);
}

export default TitleBox;
