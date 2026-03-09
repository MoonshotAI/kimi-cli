import { create } from "zustand";

export interface QueuedItem {
  id: string;
  text: string;
}

type QueueStore = {
  queue: QueuedItem[];
  enqueue: (text: string) => void;
  removeFromQueue: (id: string) => void;
  editQueueItem: (id: string, text: string) => void;
  moveQueueItemUp: (id: string) => void;
  dequeue: () => QueuedItem | undefined;
  clearQueue: () => void;
};

export const useQueueStore = create<QueueStore>((set, get) => ({
  queue: [],
  enqueue: (text) =>
    set((s) => ({
      queue: [...s.queue, { id: crypto.randomUUID(), text }],
    })),
  removeFromQueue: (id) =>
    set((s) => ({ queue: s.queue.filter((q) => q.id !== id) })),
  editQueueItem: (id, text) =>
    set((s) => ({
      queue: s.queue.map((q) => (q.id === id ? { ...q, text } : q)),
    })),
  moveQueueItemUp: (id) =>
    set((s) => {
      const idx = s.queue.findIndex((q) => q.id === id);
      if (idx <= 0) return s;
      const next = [...s.queue];
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      return { queue: next };
    }),
  dequeue: () => {
    const { queue } = get();
    if (queue.length === 0) return undefined;
    const [first, ...rest] = queue;
    set({ queue: rest });
    return first;
  },
  clearQueue: () => set({ queue: [] }),
}));
