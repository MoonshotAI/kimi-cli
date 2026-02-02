import { useEffect, useState } from "react";

export function useVideoThumbnail(url?: string): string | null {
  const [poster, setPoster] = useState<string | null>(null);

  useEffect(() => {
    if (!url) {
      setPoster(null);
      return;
    }

    let cancelled = false;
    setPoster(null);

    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.crossOrigin = "anonymous";

    const capture = () => {
      if (cancelled) {
        return;
      }
      if (!(video.videoWidth && video.videoHeight)) {
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return;
      }
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
        if (!cancelled) {
          setPoster(dataUrl);
        }
      } catch {
        // Ignore CORS/tainted canvas errors and fall back to native video preview.
      }
    };

    const handleLoadedMetadata = () => {
      const duration = video.duration;
      if (Number.isFinite(duration) && duration > 0) {
        const targetTime = Math.min(0.1, duration / 2);
        try {
          video.currentTime = targetTime;
        } catch {
          // Some browsers may reject the seek; rely on loadeddata instead.
        }
      }
    };

    const handleLoadedData = () => {
      capture();
    };

    const handleSeeked = () => {
      capture();
    };

    video.addEventListener("loadedmetadata", handleLoadedMetadata);
    video.addEventListener("loadeddata", handleLoadedData);
    video.addEventListener("seeked", handleSeeked);
    video.src = url;
    video.load();

    return () => {
      cancelled = true;
      video.removeEventListener("loadedmetadata", handleLoadedMetadata);
      video.removeEventListener("loadeddata", handleLoadedData);
      video.removeEventListener("seeked", handleSeeked);
      video.removeAttribute("src");
      video.load();
    };
  }, [url]);

  return poster;
}
