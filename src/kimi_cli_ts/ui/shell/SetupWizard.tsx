/**
 * SetupWizard.tsx — First-time setup wizard.
 * Corresponds to Python's ui/shell/setup.py.
 *
 * Features:
 * - Platform selection
 * - API key input
 * - Model selection
 * - Thinking mode toggle
 */

import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";

// ── Types ───────────────────────────────────────────────

export interface PlatformInfo {
	id: string;
	name: string;
}

export interface ModelInfo {
	id: string;
	contextLength?: number;
	capabilities?: string[];
}

export type SetupStep =
	| "platform"
	| "api_key"
	| "verifying"
	| "model"
	| "thinking"
	| "done"
	| "error";

export interface SetupResult {
	platformId: string;
	platformName: string;
	apiKey: string;
	modelId: string;
	thinking: boolean;
}

export interface SetupWizardProps {
	platforms: PlatformInfo[];
	onVerifyKey?: (platformId: string, apiKey: string) => Promise<ModelInfo[]>;
	onComplete?: (result: SetupResult) => void;
	onCancel?: () => void;
}

// ── SetupWizard ─────────────────────────────────────────

export function SetupWizard({
	platforms,
	onVerifyKey,
	onComplete,
	onCancel,
}: SetupWizardProps) {
	const [step, setStep] = useState<SetupStep>("platform");
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [selectedPlatform, setSelectedPlatform] = useState<PlatformInfo | null>(
		null,
	);
	const [apiKey, setApiKey] = useState("");
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [selectedModel, setSelectedModel] = useState<ModelInfo | null>(null);
	const [thinking, setThinking] = useState(false);
	const [error, setError] = useState<string>("");

	const finishSetup = useCallback(
		(model: ModelInfo, thinkingMode: boolean) => {
			setStep("done");
			setSelectedModel(model);
			setThinking(thinkingMode);
			onComplete?.({
				platformId: selectedPlatform!.id,
				platformName: selectedPlatform!.name,
				apiKey: apiKey.trim(),
				modelId: model.id,
				thinking: thinkingMode,
			});
		},
		[selectedPlatform, apiKey, onComplete],
	);

	const handleVerifyKey = useCallback(async () => {
		if (!selectedPlatform || !apiKey.trim()) return;
		setStep("verifying");
		try {
			const result = await onVerifyKey?.(selectedPlatform.id, apiKey.trim());
			if (result && result.length > 0) {
				setModels(result);
				setStep("model");
				setSelectedIndex(0);
			} else {
				setError("No models available for the selected platform.");
				setStep("error");
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to verify API key.");
			setStep("error");
		}
	}, [selectedPlatform, apiKey, onVerifyKey]);

	useInput((input, key) => {
		if (key.escape) {
			onCancel?.();
			return;
		}

		switch (step) {
			case "platform": {
				if (key.upArrow) {
					setSelectedIndex(
						(i) => (i - 1 + platforms.length) % platforms.length,
					);
				} else if (key.downArrow) {
					setSelectedIndex((i) => (i + 1) % platforms.length);
				} else if (key.return) {
					const platform = platforms[selectedIndex]!;
					setSelectedPlatform(platform);
					setStep("api_key");
					setSelectedIndex(0);
				}
				break;
			}

			case "api_key": {
				if (key.return && apiKey.trim()) {
					handleVerifyKey();
				} else if (key.backspace || key.delete) {
					setApiKey((k) => k.slice(0, -1));
				} else if (input && !key.ctrl && !key.meta) {
					setApiKey((k) => k + input);
				}
				break;
			}

			case "model": {
				if (key.upArrow) {
					setSelectedIndex((i) => (i - 1 + models.length) % models.length);
				} else if (key.downArrow) {
					setSelectedIndex((i) => (i + 1) % models.length);
				} else if (key.return) {
					const model = models[selectedIndex]!;
					const caps = model.capabilities || [];
					if (caps.includes("always_thinking")) {
						finishSetup(model, true);
					} else if (caps.includes("thinking")) {
						setSelectedModel(model);
						setStep("thinking");
						setSelectedIndex(0);
					} else {
						finishSetup(model, false);
					}
				}
				break;
			}

			case "thinking": {
				const choices = ["on", "off"];
				if (key.upArrow) {
					setSelectedIndex((i) => (i - 1 + choices.length) % choices.length);
				} else if (key.downArrow) {
					setSelectedIndex((i) => (i + 1) % choices.length);
				} else if (key.return) {
					finishSetup(selectedModel!, selectedIndex === 0);
				}
				break;
			}

			case "error": {
				if (key.return) {
					setStep("api_key");
					setApiKey("");
					setError("");
				}
				break;
			}
		}
	});

	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor="cyan"
			paddingX={2}
			paddingY={1}
		>
			<Text color="cyan" bold>
				🔧 Setup Wizard
			</Text>
			<Text> </Text>

			{step === "platform" && (
				<>
					<Text>
						Select a platform (↑↓ navigate, Enter select, Esc cancel):
					</Text>
					<Text> </Text>
					{platforms.map((platform, i) => (
						<Text
							key={platform.id}
							color={i === selectedIndex ? "cyan" : "grey"}
						>
							{i === selectedIndex ? "→" : " "} {platform.name}
						</Text>
					))}
				</>
			)}

			{step === "api_key" && (
				<>
					<Text>
						Enter your API key for <Text bold>{selectedPlatform?.name}</Text>:
					</Text>
					<Text> </Text>
					<Box>
						<Text> {">"} </Text>
						<Text>{apiKey ? "•".repeat(apiKey.length) : ""}</Text>
						<Text>█</Text>
					</Box>
					<Text> </Text>
					<Text dimColor>Press Enter to verify, Esc to cancel.</Text>
				</>
			)}

			{step === "verifying" && <Text color="cyan">Verifying API key...</Text>}

			{step === "model" && (
				<>
					<Text>Select a model (↑↓ navigate, Enter select):</Text>
					<Text> </Text>
					{models.map((model, i) => (
						<Text key={model.id} color={i === selectedIndex ? "cyan" : "grey"}>
							{i === selectedIndex ? "→" : " "} {model.id}
						</Text>
					))}
				</>
			)}

			{step === "thinking" && (
				<>
					<Text>Enable thinking mode? (↑↓ navigate, Enter select):</Text>
					<Text> </Text>
					{["on", "off"].map((choice, i) => (
						<Text key={choice} color={i === selectedIndex ? "cyan" : "grey"}>
							{i === selectedIndex ? "→" : " "} {choice}
						</Text>
					))}
				</>
			)}

			{step === "done" && (
				<>
					<Text color="green">✓ Setup complete!</Text>
					<Text>
						{" "}
						Platform: <Text bold>{selectedPlatform?.name}</Text>
					</Text>
					<Text>
						{" "}
						Model: <Text bold>{selectedModel?.id}</Text>
					</Text>
					<Text>
						{" "}
						Thinking: <Text bold>{thinking ? "on" : "off"}</Text>
					</Text>
					<Text> Reloading...</Text>
				</>
			)}

			{step === "error" && (
				<>
					<Text color="red">{error}</Text>
					<Text> </Text>
					<Text dimColor>Press Enter to try again, Esc to cancel.</Text>
				</>
			)}
		</Box>
	);
}

export default SetupWizard;
