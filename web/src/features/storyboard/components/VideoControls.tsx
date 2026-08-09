import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { IconButton, Tooltip } from "../../../shared/ui";
import styles from "./MediaStage.module.css";

export function VideoControls({
  currentTime,
  duration,
  muted,
  playing,
  onSeek,
  onToggleMuted,
  onTogglePlayback,
}: {
  currentTime: number;
  duration: number;
  muted: boolean;
  playing: boolean;
  onSeek: (time: number) => void;
  onToggleMuted: () => void;
  onTogglePlayback: () => void;
}) {
  return (
    <div className={styles.controls}>
      <Tooltip content={playing ? "暂停" : "播放"}>
        <IconButton
          label={playing ? "暂停" : "播放"}
          icon={playing ? <Pause size={16} /> : <Play size={16} />}
          onClick={onTogglePlayback}
        />
      </Tooltip>
      <input
        aria-label="播放进度"
        type="range"
        min={0}
        max={duration || 0}
        step="0.05"
        value={Math.min(currentTime, duration || 0)}
        onChange={(event) => onSeek(Number(event.target.value))}
      />
      <span>{formatTime(currentTime)} / {formatTime(duration)}</span>
      <Tooltip content={muted ? "开启声音" : "静音"}>
        <IconButton
          label={muted ? "开启声音" : "静音"}
          icon={muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          onClick={onToggleMuted}
        />
      </Tooltip>
    </div>
  );
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}
