import {
  type KeyboardEvent,
  type ReactElement,
  memo,
  useCallback,
  useState,
} from "react";
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  ListOrderedIcon,
  PencilIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useQueueStore, type QueuedItem } from "../../queue-store";

// ─── Sub-components ──────────────────────────────────────────

function QueueItemRow({ item, isFirst, onEdit }: { item: QueuedItem; isFirst: boolean; onEdit: (id: string) => void }): ReactElement {
  const removeFromQueue = useQueueStore((s) => s.removeFromQueue);
  const moveQueueItemUp = useQueueStore((s) => s.moveQueueItemUp);

  return (
    <div className="group flex items-center gap-1.5 px-3 py-1.5  hover:bg-muted/50 transition-colors">
      <p className="min-w-0 text-xs text-foreground truncate leading-relaxed">
        {item.text}
      </p>
      <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="size-5" onClick={() => onEdit(item.id)}>
              <PencilIcon className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Edit</TooltipContent>
        </Tooltip>
        {!isFirst && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="size-5" onClick={() => moveQueueItemUp(item.id)}>
                <ArrowUpIcon className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Move up</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="size-5 text-muted-foreground hover:text-destructive" onClick={() => removeFromQueue(item.id)}>
              <Trash2Icon className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Remove</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

function EditingItemRow({ item, onDone }: { item: QueuedItem; onDone: () => void }): ReactElement {
  const [text, setText] = useState(item.text);
  const editQueueItem = useQueueStore((s) => s.editQueueItem);

  const handleSave = useCallback(() => {
    if (text.trim()) editQueueItem(item.id, text.trim());
    onDone();
  }, [text, item.id, editQueueItem, onDone]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); handleSave(); }
    if (e.key === "Escape") { e.preventDefault(); onDone(); }
  }, [handleSave, onDone]);

  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 bg-muted/30">
      <input
        autoFocus
        aria-label="Edit queued message"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        className="flex-1 min-w-0 text-xs bg-transparent border-b border-border outline-none py-0.5"
      />
      <Button variant="ghost" size="icon-sm" className="size-5" onClick={handleSave}>
        <CheckIcon className="size-3" />
      </Button>
      <Button variant="ghost" size="icon-sm" className="size-5" onClick={onDone}>
        <XIcon className="size-3" />
      </Button>
    </div>
  );
}

// ─── Exported components ─────────────────────────────────────

type ToolbarQueuePanelProps = {
  queue: QueuedItem[];
};

export const ToolbarQueuePanel = memo(function ToolbarQueuePanelComponent({
  queue,
}: ToolbarQueuePanelProps): ReactElement {
  const [editingId, setEditingId] = useState<string | null>(null);
  const handleEditDone = useCallback(() => setEditingId(null), []);

  return (
    <>
      {queue.map((item, idx) =>
        editingId === item.id ? (
          <EditingItemRow key={item.id} item={item} onDone={handleEditDone} />
        ) : (
          <QueueItemRow key={item.id} item={item} isFirst={idx === 0} onEdit={setEditingId} />
        ),
      )}
    </>
  );
});

type ToolbarQueueTabProps = {
  count: number;
  isActive: boolean;
  onToggle: () => void;
};

export const ToolbarQueueTab = memo(function ToolbarQueueTabComponent({
  count,
  isActive,
  onToggle,
}: ToolbarQueueTabProps): ReactElement {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "flex items-center gap-1.5 h-7 px-2.5 rounded-full text-xs font-medium transition-colors cursor-pointer border",
        isActive
          ? "bg-secondary text-foreground border-border shadow-sm"
          : "bg-transparent text-muted-foreground border-border/60 hover:text-foreground hover:border-border",
      )}
    >
      <ListOrderedIcon className="size-3" />
      <span>{count} Queued</span>
      <ChevronDownIcon
        className={cn(
          "size-3 transition-transform duration-200",
          isActive && "rotate-180",
        )}
      />
    </button>
  );
});
