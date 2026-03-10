import { useState } from "react";
import type { ContextMessage } from "@/lib/api";
import { normalizeContent } from "@/lib/api";
import { Markdown } from "@/components/markdown";
import { useRawMode } from "./context-viewer";
import { ChevronDown, ChevronRight, User, Image, Music, Video } from "lucide-react";

interface UserMessageProps {
  message: ContextMessage;
}

export function UserMessage({ message }: UserMessageProps) {
  const [showRaw, setShowRaw] = useState(false);

  const parts = normalizeContent(message.content);

  const textContent = parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");

  const images = parts.filter((p) => p.type === "image_url");
  const audios = parts.filter((p) => p.type === "audio_url");
  const videos = parts.filter((p) => p.type === "video_url");

  return (
    <div className="my-2 flex gap-3">
      {/* Avatar */}
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
        <User size={14} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-semibold">User</span>
          {message.name && (
            <span className="text-[10px] font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              {message.name}
            </span>
          )}
          <button
            onClick={() => setShowRaw(!showRaw)}
            className="text-[10px] text-muted-foreground hover:text-foreground"
          >
            {showRaw ? (
              <ChevronDown size={12} className="inline" />
            ) : (
              <ChevronRight size={12} className="inline" />
            )}{" "}
            raw
          </button>
        </div>

        {/* Text content */}
        <TextContent text={textContent} />

        {/* Images */}
        {images.map((img, i) => (
          <div key={i} className="mt-2">
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-1">
              <Image size={10} />
              <span>Image</span>
              {img.image_url?.id && <span className="font-mono">({img.image_url.id})</span>}
            </div>
            <img
              src={img.image_url?.url}
              alt="attachment"
              className="max-w-sm rounded-md border"
            />
          </div>
        ))}

        {/* Audio */}
        {audios.map((aud, i) => (
          <div key={`audio-${i}`} className="mt-2">
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-1">
              <Music size={10} />
              <span>Audio</span>
              {aud.audio_url?.id && <span className="font-mono">({aud.audio_url.id})</span>}
            </div>
            <audio controls src={aud.audio_url?.url} className="max-w-sm" />
          </div>
        ))}

        {/* Video */}
        {videos.map((vid, i) => (
          <div key={`video-${i}`} className="mt-2">
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-1">
              <Video size={10} />
              <span>Video</span>
              {vid.video_url?.id && <span className="font-mono">({vid.video_url.id})</span>}
            </div>
            <video controls src={vid.video_url?.url} className="max-w-sm rounded-md border" />
          </div>
        ))}

        {/* Raw JSON */}
        {showRaw && (
          <div className="mt-2 rounded-md border bg-card p-2">
            <pre className="overflow-auto whitespace-pre-wrap text-[11px] font-mono text-muted-foreground max-h-[500px]">
              {JSON.stringify(message, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

function TextContent({ text }: { text: string }) {
  const rawMode = useRawMode();
  return (
    <div className="rounded-lg bg-primary/10 px-3 py-2">
      {text ? (
        rawMode ? (
          <pre className="whitespace-pre-wrap text-sm font-mono leading-relaxed">{text}</pre>
        ) : (
          <Markdown>{text}</Markdown>
        )
      ) : (
        <span className="text-sm text-muted-foreground">(empty)</span>
      )}
    </div>
  );
}
