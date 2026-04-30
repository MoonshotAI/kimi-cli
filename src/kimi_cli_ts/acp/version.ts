/**
 * ACP version negotiation — corresponds to Python acp/version.py
 */

export interface ACPVersionSpec {
	/** Negotiation integer (currently 1). */
	protocolVersion: number;
	/** ACP spec tag (e.g. "v0.10.8"). */
	specTag: string;
	/** Corresponding SDK version (e.g. "0.8.0"). */
	sdkVersion: string;
}

export const CURRENT_VERSION: ACPVersionSpec = {
	protocolVersion: 1,
	specTag: "v0.10.8",
	sdkVersion: "0.8.0",
};

export const SUPPORTED_VERSIONS: Map<number, ACPVersionSpec> = new Map([
	[1, CURRENT_VERSION],
]);

export const MIN_PROTOCOL_VERSION = 1;

/**
 * Negotiate the protocol version with the client.
 *
 * Returns the highest server-supported version that does not exceed the
 * client's requested version. If the client version is lower than
 * MIN_PROTOCOL_VERSION the server still returns its own current version
 * so the client can decide whether to disconnect.
 */
export function negotiateVersion(
	clientProtocolVersion: number,
): ACPVersionSpec {
	if (clientProtocolVersion < MIN_PROTOCOL_VERSION) {
		return CURRENT_VERSION;
	}

	let best: ACPVersionSpec | null = null;
	for (const [ver, spec] of SUPPORTED_VERSIONS) {
		if (
			ver <= clientProtocolVersion &&
			(best === null || ver > best.protocolVersion)
		) {
			best = spec;
		}
	}

	return best ?? CURRENT_VERSION;
}
