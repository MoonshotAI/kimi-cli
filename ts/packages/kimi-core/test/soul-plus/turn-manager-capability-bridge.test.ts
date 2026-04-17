/**
 * Phase 19 Slice B bridge test — verifies `TurnManager.handlePrompt`
 * integrates `checkLLMCapabilities` against the `KosongAdapter.getCapability`
 * surface so an image / video input against an image/video-blind model is
 * rejected with `LLMCapabilityMismatchError` BEFORE any WAL record is
 * written or a turn id is allocated.
 *
 * Also pins the "missing capability → skip gate" open-world branch: an
 * adapter that does not expose `getCapability` (or returns `undefined`) must
 * allow the prompt through unchanged.
 */

import { describe, expect, it } from 'vitest';
import type { ModelCapability } from '@moonshot-ai/kosong';

import {
  LLMCapabilityMismatchError,
  SessionEventBus,
  SessionLifecycleStateMachine,
  SoulLifecycleGate,
  SoulRegistry,
  TurnManager,
  createRuntime,
} from '../../src/soul-plus/index.js';
import type { Runtime, Tool } from '../../src/soul/index.js';
import { InMemorySessionJournalImpl } from '../../src/storage/session-journal.js';
import { makeEndTurnResponse } from '../soul/fixtures/common.js';
import { ScriptedKosongAdapter } from '../soul/fixtures/scripted-kosong.js';
import {
  createHarnessContextState,
  createNoopCompactionProvider,
  createNoopJournalCapability,
} from './fixtures/slice3-harness.js';
import { makeRealSubcomponents } from './fixtures/real-subcomponents.js';

class CapabilityAwareScriptedAdapter extends ScriptedKosongAdapter {
  constructor(
    opts: ConstructorParameters<typeof ScriptedKosongAdapter>[0],
    private readonly capability: ModelCapability | undefined,
  ) {
    super(opts);
  }
  getCapability(): ModelCapability | undefined {
    return this.capability;
  }
}

function buildManager(opts: {
  readonly kosong: ScriptedKosongAdapter;
  readonly model?: string;
  readonly tools?: readonly Tool[];
}): {
  manager: TurnManager;
  journal: InMemorySessionJournalImpl;
  stateMachine: SessionLifecycleStateMachine;
  runtime: Runtime;
} {
  const stateMachine = new SessionLifecycleStateMachine();
  const gate = new SoulLifecycleGate(stateMachine);
  const context = createHarnessContextState({ initialModel: opts.model ?? 'test-model' });
  const journal = new InMemorySessionJournalImpl();
  const eventBus = new SessionEventBus();
  const runtime = createRuntime({
    kosong: opts.kosong,
    lifecycle: gate,
    compactionProvider: createNoopCompactionProvider(),
    journal: createNoopJournalCapability(),
  });
  const soulRegistry = new SoulRegistry({
    createHandle: (key) => ({
      key,
      agentId: 'agent_main',
      abortController: new AbortController(),
    }),
  });
  const subcomponents = makeRealSubcomponents({
    contextState: context,
    lifecycleStateMachine: stateMachine,
    sink: eventBus,
  });
  const manager = new TurnManager({
    contextState: context,
    sessionJournal: journal,
    runtime,
    sink: eventBus,
    lifecycleStateMachine: stateMachine,
    soulRegistry,
    tools: opts.tools ?? [],
    compaction: subcomponents.compaction,
    permissionBuilder: subcomponents.permissionBuilder,
    lifecycle: subcomponents.lifecycle,
    wakeScheduler: subcomponents.wakeScheduler,
  });
  return { manager, journal, stateMachine, runtime };
}

const IMAGE_BLIND_CAPABILITY: ModelCapability = Object.freeze({
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: true,
  max_context_tokens: 128_000,
});

const FULLY_CAPABLE: ModelCapability = Object.freeze({
  image_in: true,
  video_in: true,
  audio_in: true,
  thinking: true,
  tool_use: true,
  max_context_tokens: 256_000,
});

describe('TurnManager.handlePrompt capability bridge (Phase 19 Slice B)', () => {
  it('rejects image-bearing prompt when model declares image_in=false', async () => {
    const kosong = new CapabilityAwareScriptedAdapter(
      { responses: [makeEndTurnResponse('unused')] },
      IMAGE_BLIND_CAPABILITY,
    );
    const { manager, journal, stateMachine } = buildManager({
      kosong,
      model: 'kimi-blind',
    });

    await expect(
      manager.handlePrompt({
        data: {
          input: {
            text: 'describe this image',
            parts: [
              { type: 'text', text: 'describe this image' },
              { type: 'image_url', image_url: { url: 'https://example.com/x.png' } },
            ],
          },
        },
      }),
    ).rejects.toBeInstanceOf(LLMCapabilityMismatchError);

    // No turn_begin written → no WAL residue on capability failure.
    expect(journal.getRecordsByType('turn_begin')).toHaveLength(0);
    // Lifecycle stays idle — no transition to active.
    expect(stateMachine.state).toBe('idle');
    // Kosong was never called.
    expect(kosong.callCount).toBe(0);
  });

  it('rejects video-bearing prompt when model declares video_in=false', async () => {
    const kosong = new CapabilityAwareScriptedAdapter(
      { responses: [makeEndTurnResponse('unused')] },
      IMAGE_BLIND_CAPABILITY,
    );
    const { manager } = buildManager({ kosong, model: 'kimi-blind' });
    await expect(
      manager.handlePrompt({
        data: {
          input: {
            text: 'describe this video',
            parts: [
              { type: 'text', text: 'describe this video' },
              { type: 'video_url', video_url: { url: 'https://example.com/v.mp4' } },
            ],
          },
        },
      }),
    ).rejects.toBeInstanceOf(LLMCapabilityMismatchError);
  });

  it('accepts image prompt when capability permits image_in', async () => {
    const kosong = new CapabilityAwareScriptedAdapter(
      { responses: [makeEndTurnResponse('ok')] },
      FULLY_CAPABLE,
    );
    const { manager } = buildManager({ kosong, model: 'kimi-capable' });
    const res = await manager.handlePrompt({
      data: {
        input: {
          text: 'describe',
          parts: [
            { type: 'text', text: 'describe' },
            { type: 'image_url', image_url: { url: 'https://example.com/x.png' } },
          ],
        },
      },
    });
    expect(res).toMatchObject({ status: 'started' });
  });

  it('skips the gate when adapter has no getCapability (open-world permissive)', async () => {
    // Base ScriptedKosongAdapter has no getCapability → undefined branch.
    const kosong = new ScriptedKosongAdapter({ responses: [makeEndTurnResponse('ok')] });
    const { manager } = buildManager({ kosong });
    const res = await manager.handlePrompt({
      data: {
        input: {
          text: 'describe',
          parts: [
            { type: 'text', text: 'describe' },
            { type: 'image_url', image_url: { url: 'https://example.com/x.png' } },
          ],
        },
      },
    });
    expect(res).toMatchObject({ status: 'started' });
  });

  it('skips the gate when getCapability returns undefined', async () => {
    const kosong = new CapabilityAwareScriptedAdapter(
      { responses: [makeEndTurnResponse('ok')] },
      undefined,
    );
    const { manager } = buildManager({ kosong, model: 'unknown-model' });
    const res = await manager.handlePrompt({
      data: {
        input: {
          text: 'describe',
          parts: [
            { type: 'text', text: 'describe' },
            { type: 'image_url', image_url: { url: 'https://example.com/x.png' } },
          ],
        },
      },
    });
    expect(res).toMatchObject({ status: 'started' });
  });

  it('passes a text-only prompt through even with image-blind capability', async () => {
    const kosong = new CapabilityAwareScriptedAdapter(
      { responses: [makeEndTurnResponse('ok')] },
      IMAGE_BLIND_CAPABILITY,
    );
    const { manager } = buildManager({ kosong, model: 'kimi-blind' });
    const res = await manager.handlePrompt({
      data: { input: { text: 'plain text', parts: [{ type: 'text', text: 'plain text' }] } },
    });
    expect(res).toMatchObject({ status: 'started' });
  });
});
