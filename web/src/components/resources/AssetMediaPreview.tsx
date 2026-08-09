import { ImageOff, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { UIStrings } from "../../i18n";

function isVideoUrl(url: string): boolean {
  return /\.(?:mp4|mov|webm)(?:[?#]|$)/i.test(url);
}

export function AssetMediaPreview({
  url,
  label,
  controls = false,
  strings,
}: {
  url: string;
  label: string;
  controls?: boolean;
  strings: UIStrings["resources"];
}) {
  const [state, setState] = useState<"empty" | "loading" | "ready" | "failed">(
    url ? "loading" : "empty",
  );
  const previousUrlRef = useRef(url);

  useEffect(() => {
    if (previousUrlRef.current === url) return;
    previousUrlRef.current = url;
    setState(url ? "loading" : "empty");
  }, [url]);

  return (
    <span className="asset-media-frame" data-media-state={state}>
      {url && state !== "failed" ? (
        isVideoUrl(url) ? (
          <video
            src={url}
            controls={controls}
            muted={!controls}
            preload="metadata"
            aria-label={label}
            onLoadedData={() => setState("ready")}
            onError={() => setState("failed")}
          />
        ) : (
          <img
            src={url}
            alt={controls ? label : ""}
            loading="lazy"
            onLoad={() => setState("ready")}
            onError={() => setState("failed")}
          />
        )
      ) : null}
      {state === "loading" ? (
        <span className="asset-media-state" role="status">
          <LoaderCircle aria-hidden="true" size={20} />
          {strings.loadingPreview}
        </span>
      ) : null}
      {state === "empty" || state === "failed" ? (
        <span className="asset-media-state" role={state === "failed" ? "alert" : undefined}>
          <ImageOff aria-hidden="true" size={22} />
          {state === "failed" ? strings.previewFailed : strings.noPreview}
        </span>
      ) : null}
    </span>
  );
}
