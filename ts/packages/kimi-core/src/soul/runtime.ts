import type { Kaos } from '@moonshot-ai/kaos';
import type { ChatProvider, Toolset } from '@moonshot-ai/kosong';

export interface Runtime {
  readonly llm: ChatProvider;
  readonly kaos: Kaos;
  readonly toolset: Toolset;
  readonly maxStepsPerTurn: number;
}
