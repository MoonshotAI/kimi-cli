/**
 * Phase 19 Slice B.3 — production capability-mismatch gate.
 *
 * Given a declared {@link ModelCapability} (fetched by the caller from
 * `provider.getCapability()`) and flags describing the input modalities,
 * return an {@link LLMCapabilityMismatchError} when the input asks for
 * something the model does not accept. Otherwise return `undefined`.
 *
 * The helper is intentionally pure and strict — it trusts the capability
 * argument verbatim. The permissive "no capability available" branch is
 * owned by the caller (see `session.prompt` handler), which simply skips
 * the check when it cannot obtain a capability.
 */

import type { ModelCapability } from '@moonshot-ai/kosong';

import { LLMCapabilityMismatchError } from './errors.js';

export interface LLMCapabilityCheckOptions {
  readonly model: string;
  readonly inputContainsImage: boolean;
  readonly inputContainsVideo: boolean;
  readonly inputContainsAudio: boolean;
  readonly capability: ModelCapability;
}

export function checkLLMCapabilities(
  opts: LLMCapabilityCheckOptions,
): LLMCapabilityMismatchError | undefined {
  // "No model configured" is surfaced separately as -32001
  // (LLMNotSetError), not as a capability mismatch.
  if (opts.model === '') {
    return undefined;
  }

  const { model, capability, inputContainsImage, inputContainsVideo, inputContainsAudio } = opts;

  // Image is checked first so multi-modality rejects produce a stable
  // primary reason the caller can surface — tests assert only that *a*
  // mismatch error is returned, but a deterministic order keeps
  // operator-facing messages predictable.
  if (inputContainsImage && !capability.image_in) {
    return new LLMCapabilityMismatchError(
      `Model "${model}" does not accept image input (image_in: false)`,
    );
  }
  if (inputContainsVideo && !capability.video_in) {
    return new LLMCapabilityMismatchError(`Model "${model}" does not accept video input`);
  }
  if (inputContainsAudio && !capability.audio_in) {
    return new LLMCapabilityMismatchError(`Model "${model}" does not accept audio input`);
  }

  return undefined;
}
