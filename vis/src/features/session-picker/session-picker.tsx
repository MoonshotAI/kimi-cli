import { useCallback, useEffect, useMemo, useState } from "react";
import { type SessionInfo, listSessions } from "@/lib/api";
import { Search } from "lucide-react";

interface SessionPickerProps {
  value: string | null;
  onChange: (sessionId: string | null) => void;
}

function formatTime(ts: number): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleString();
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

export function SessionPicker({ value, onChange }: SessionPickerProps) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState(value ?? "");

  useEffect(() => {
    listSessions()
      .then(setSessions)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    setInputValue(value ?? "");
  }, [value]);

  const filtered = useMemo(() => {
    if (!search) return sessions;
    const q = search.toLowerCase();
    return sessions.filter(
      (s) =>
        s.session_id.toLowerCase().includes(q) ||
        s.title.toLowerCase().includes(q) ||
        (s.work_dir && s.work_dir.toLowerCase().includes(q)),
    );
  }, [sessions, search]);

  const handleSelect = useCallback(
    (sessionId: string) => {
      onChange(sessionId);
      setOpen(false);
      setSearch("");
    },
    [onChange],
  );

  const handleInputSubmit = useCallback(() => {
    const trimmed = inputValue.trim();
    if (trimmed) {
      onChange(trimmed);
    }
    setOpen(false);
  }, [inputValue, onChange]);

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <label className="text-sm font-medium text-muted-foreground whitespace-nowrap">
          Session:
        </label>
        <div className="relative flex-1">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value);
              setSearch(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handleInputSubmit();
              }
              if (e.key === "Escape") {
                setOpen(false);
              }
            }}
            placeholder="Select or paste a session ID..."
            className="h-8 w-full rounded-md border bg-background px-3 pr-8 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <Search
            size={14}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
        </div>
      </div>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 right-0 z-50 mt-1 max-h-80 overflow-auto rounded-md border bg-popover shadow-lg">
            {loading && (
              <div className="p-3 text-sm text-muted-foreground">
                Loading sessions...
              </div>
            )}
            {!loading && filtered.length === 0 && (
              <div className="p-3 text-sm text-muted-foreground">
                No sessions found
              </div>
            )}
            {filtered.map((session) => (
              <button
                key={session.session_id}
                onClick={() => handleSelect(session.session_id)}
                className={`w-full px-3 py-2 text-left text-sm hover:bg-accent transition-colors ${
                  session.session_id === value ? "bg-accent" : ""
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">
                    {shortId(session.session_id)}
                  </span>
                  <span className="truncate flex-1">
                    {session.title || "Untitled Session"}
                  </span>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {formatTime(session.last_updated)}
                  </span>
                </div>
                {session.work_dir && (
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {session.work_dir}
                  </div>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
