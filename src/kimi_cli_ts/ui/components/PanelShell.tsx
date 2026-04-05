/**
 * PanelShell.tsx — Universal bordered container for terminal panels.
 *
 * Two variant modes:
 * - "box": Unicode box border (╭─╮│╰─╯) with title centered in top border.
 *   Used by UsagePanel.
 * - "rules": Horizontal rule lines (─) as top/bottom separator with header.
 *   Used by CommandPanel.
 *
 * Pure render component — no useInput.
 */

import React from "react";
import { Box, Text } from "ink";
import { getTerminalSize } from "../shell/console.ts";

// ── Border characters ────────────────────────────────────

const BOX_TL = "\u256D"; // ╭
const BOX_TR = "\u256E"; // ╮
const BOX_BL = "\u2570"; // ╰
const BOX_BR = "\u256F"; // ╯
const BOX_H = "\u2500"; // ─
const BOX_V = "\u2502"; // │

// ── Default colors ───────────────────────────────────────

const DEFAULT_BOX_BORDER = "#d2b48c";
const DEFAULT_RULES_BORDER = "#555555";
const DEFAULT_FOOTER_COLOR = "#808080";

// ── Props ────────────────────────────────────────────────

export interface PanelShellProps {
	variant?: "box" | "rules";
	borderColor?: string;
	width?: "fit" | "full";
	paddingX?: number;
	contentWidth?: number;

	title?: string;
	titleColor?: string;
	titlePosition?: "border" | "inside";

	footerHints?: string[];
	footerLeft?: string;
	footerColor?: string;

	children: React.ReactNode;
}

// ── PanelRow (for box variant) ───────────────────────────

export interface PanelRowProps {
	borderColor?: string;
	paddingX?: number;
	contentWidth?: number;
	children: React.ReactNode;
}

/**
 * A row inside a box-variant PanelShell.
 * Wraps children with │ + padding + content + padding + │.
 */
export function PanelRow({
	borderColor = DEFAULT_BOX_BORDER,
	paddingX = 2,
	contentWidth,
	children,
}: PanelRowProps) {
	const pad = " ".repeat(paddingX);

	if (contentWidth != null) {
		// Fixed-width row: right-pad content area so │ aligns
		return (
			<Text>
				<Text color={borderColor}>{BOX_V}</Text>
				<Text>{pad}</Text>
				{children}
				<Text>{pad}</Text>
				<Text color={borderColor}>{BOX_V}</Text>
			</Text>
		);
	}

	return (
		<Text>
			<Text color={borderColor}>{BOX_V}</Text>
			<Text>{pad}</Text>
			{children}
			<Text>{pad}</Text>
			<Text color={borderColor}>{BOX_V}</Text>
		</Text>
	);
}

// ── PanelShell ───────────────────────────────────────────

export function PanelShell({
	variant = "box",
	borderColor,
	width,
	paddingX,
	contentWidth,
	title,
	titleColor,
	titlePosition,
	footerHints,
	footerLeft,
	footerColor = DEFAULT_FOOTER_COLOR,
	children,
}: PanelShellProps) {
	if (variant === "rules") {
		return (
			<RulesVariant
				borderColor={borderColor}
				width={width}
				paddingX={paddingX}
				title={title}
				titleColor={titleColor}
				footerHints={footerHints}
				footerLeft={footerLeft}
				footerColor={footerColor}
			>
				{children}
			</RulesVariant>
		);
	}

	return (
		<BoxVariant
			borderColor={borderColor}
			width={width}
			paddingX={paddingX}
			contentWidth={contentWidth}
			title={title}
			titleColor={titleColor}
			titlePosition={titlePosition}
			footerHints={footerHints}
			footerLeft={footerLeft}
			footerColor={footerColor}
		>
			{children}
		</BoxVariant>
	);
}

// ── Box variant ──────────────────────────────────────────

interface BoxVariantProps {
	borderColor?: string;
	width?: "fit" | "full";
	paddingX?: number;
	contentWidth?: number;
	title?: string;
	titleColor?: string;
	titlePosition?: "border" | "inside";
	footerHints?: string[];
	footerLeft?: string;
	footerColor: string;
	children: React.ReactNode;
}

function BoxVariant({
	borderColor = DEFAULT_BOX_BORDER,
	width = "fit",
	paddingX = 2,
	contentWidth: contentWidthProp,
	title,
	titleColor,
	titlePosition = "border",
	footerHints,
	footerLeft,
	footerColor,
	children,
}: BoxVariantProps) {
	// Determine inner width (content area between border chars)
	let innerWidth: number;
	if (width === "full") {
		const { columns } = getTerminalSize();
		innerWidth = columns - 2; // minus 2 border chars (│ │)
	} else if (contentWidthProp != null) {
		innerWidth = contentWidthProp + paddingX * 2;
	} else {
		// Fallback: let caller control via contentWidth
		innerWidth = 40;
	}

	// ── Top border ──
	let topBorder: string;
	if (title && titlePosition === "border") {
		const titleStr = ` ${title} `;
		const dashesTotal = Math.max(0, innerWidth - titleStr.length);
		const dashesLeft = Math.floor(dashesTotal / 2);
		const dashesRight = dashesTotal - dashesLeft;
		topBorder =
			BOX_TL +
			BOX_H.repeat(dashesLeft) +
			titleStr +
			BOX_H.repeat(dashesRight) +
			BOX_TR;
	} else {
		topBorder = BOX_TL + BOX_H.repeat(innerWidth) + BOX_TR;
	}

	// ── Bottom border ──
	const bottomBorder = BOX_BL + BOX_H.repeat(innerWidth) + BOX_BR;

	// ── Footer row (inside the border) ──
	const hasFooter = (footerHints && footerHints.length > 0) || footerLeft;

	return (
		<Box flexDirection="column">
			{/* Top border with optional title */}
			<Text color={borderColor}>
				{titleColor && title && titlePosition === "border" ? (
					<>
						{BOX_TL +
							BOX_H.repeat(
								Math.floor(Math.max(0, innerWidth - title.length - 2) / 2),
							)}{" "}
						<Text color={titleColor}>{title}</Text>{" "}
						{BOX_H.repeat(
							Math.max(0, innerWidth - title.length - 2) -
								Math.floor(Math.max(0, innerWidth - title.length - 2) / 2),
						) + BOX_TR}
					</>
				) : (
					topBorder
				)}
			</Text>

			{/* Inside title line (when titlePosition="inside") */}
			{title && titlePosition === "inside" && (
				<PanelRow borderColor={borderColor} paddingX={paddingX}>
					<Text color={titleColor} bold>
						{title}
					</Text>
				</PanelRow>
			)}

			{/* Children */}
			{children}

			{/* Footer row */}
			{hasFooter && (
				<PanelRow
					borderColor={borderColor}
					paddingX={paddingX}
					contentWidth={contentWidthProp}
				>
					{footerLeft && <Text color={footerColor}>{footerLeft}</Text>}
					{contentWidthProp != null && (
						<Text>
							{" ".repeat(
								Math.max(
									0,
									contentWidthProp -
										(footerLeft?.length ?? 0) -
										(footerHints ? footerHints.join("  ").length : 0),
								),
							)}
						</Text>
					)}
					{footerHints && footerHints.length > 0 && (
						<Text color={footerColor} dimColor>
							{footerHints.join("  ")}
						</Text>
					)}
				</PanelRow>
			)}

			{/* Bottom border */}
			<Text color={borderColor}>{bottomBorder}</Text>
		</Box>
	);
}

// ── Rules variant ────────────────────────────────────────

interface RulesVariantProps {
	borderColor?: string;
	width?: "fit" | "full";
	paddingX?: number;
	title?: string;
	titleColor?: string;
	footerHints?: string[];
	footerLeft?: string;
	footerColor: string;
	children: React.ReactNode;
}

function RulesVariant({
	borderColor = DEFAULT_RULES_BORDER,
	width = "full",
	paddingX = 1,
	title,
	titleColor,
	footerHints,
	footerLeft,
	footerColor,
	children,
}: RulesVariantProps) {
	const { columns } = getTerminalSize();
	const ruleWidth = width === "full" ? columns : columns;
	const rule = BOX_H.repeat(ruleWidth);

	// Build header line: title (left) + hints (middle) + footerLeft (right)
	const hasHeader =
		title || (footerHints && footerHints.length > 0) || footerLeft;

	return (
		<Box flexDirection="column">
			{/* Top rule */}
			<Text color={borderColor}>{rule}</Text>

			{/* Header line */}
			{hasHeader && (
				<Box paddingX={paddingX}>
					{title && (
						<Text bold color={titleColor}>
							{title}
						</Text>
					)}
					{footerHints && footerHints.length > 0 && (
						<Text color={footerColor} dimColor>
							{title ? " " : ""}({footerHints.join(", ")})
						</Text>
					)}
					{footerLeft && (
						<Text color={footerColor} dimColor>
							{"  "}
							{footerLeft}
						</Text>
					)}
				</Box>
			)}

			{/* Bottom rule (below header) */}
			{hasHeader && <Text color={borderColor}>{rule}</Text>}

			{/* Children */}
			{children}
		</Box>
	);
}
