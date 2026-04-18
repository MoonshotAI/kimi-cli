/**
 * Declared capabilities for a specific model exposed by a {@link ChatProvider}.
 *
 * Providers return one of these from {@link ChatProvider.getCapability} so
 * callers can gate requests against modalities the model does not accept
 * without dispatching the request and watching it fail upstream.
 *
 * `max_context_tokens: 0` means "unknown"; callers that do not consult it
 * for gating (Slice B.3 does not) can ignore the field.
 */
export interface ModelCapability {
  readonly image_in: boolean;
  readonly video_in: boolean;
  readonly audio_in: boolean;
  readonly thinking: boolean;
  readonly tool_use: boolean;
  readonly max_context_tokens: number;
}

/**
 * Shared read-only default returned when a provider has not catalogued a
 * given model. Frozen so accidental mutation at one call site cannot leak
 * into another.
 */
export const UNKNOWN_CAPABILITY: ModelCapability = Object.freeze({
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: false,
  max_context_tokens: 0,
});
