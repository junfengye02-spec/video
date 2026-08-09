import React from "react";
import {AbsoluteFill, CalculateMetadataFunction, OffthreadVideo, staticFile} from "remotion";
import {TransitionSeries, linearTiming} from "@remotion/transitions";
import {fade} from "@remotion/transitions/fade";

type TransitionType = "cut" | "dissolve" | "fade_through_black";

interface RenderTransition {
  type: TransitionType;
  duration_seconds: number;
}

interface RenderClip {
  id: string;
  source_path: string;
  source_duration_seconds: number;
  source_width?: number;
  source_height?: number;
  source_in_seconds: number;
  source_out_seconds: number;
  source_handle_before_seconds: number;
  source_handle_after_seconds: number;
  timeline_start_seconds: number;
  timeline_duration_seconds: number;
  duration_policy: "full_source" | "explicit_trim" | "explicit_retime";
  playback_rate: number;
  transition_in: RenderTransition;
  transition_out: RenderTransition;
}

export interface WorkbenchRendererProps {
  [key: string]: unknown;
  total_duration_seconds: number;
  output: {
    width: number;
    height: number;
    fps: number;
  };
  clips: RenderClip[];
}

const resolveAsset = (src: string): string => {
  if (src.startsWith("http://") || src.startsWith("https://") || src.startsWith("data:")) {
    return src;
  }
  const clean = src.replace(/^file:\/\/\/?/, "");
  if (clean.startsWith("/") || /^[A-Za-z]:[/\\]/.test(clean)) {
    return `file:///${clean.replace(/\\/g, "/")}`;
  }
  return staticFile(clean);
};

const boundaryTransition = (
  previous: RenderClip,
  current: RenderClip,
): RenderTransition => {
  if (current.transition_in.type !== "cut") {
    return current.transition_in;
  }
  return previous.transition_out;
};

const transitionSeconds = (
  previous: RenderClip,
  current: RenderClip,
): number => {
  const transition = boundaryTransition(previous, current);
  if (transition.type === "cut") {
    return 0;
  }
  return Math.max(
    0,
    Math.min(
      transition.duration_seconds,
      previous.timeline_duration_seconds,
      current.timeline_duration_seconds,
      current.timeline_start_seconds,
    ),
  );
};

export const calculateWorkbenchMetadata: CalculateMetadataFunction<WorkbenchRendererProps> =
  async ({props}) => ({
    durationInFrames: Math.max(
      1,
      Math.round(props.total_duration_seconds * props.output.fps),
    ),
    fps: props.output.fps,
    width: props.output.width,
    height: props.output.height,
  });

export const WorkbenchRenderer: React.FC<WorkbenchRendererProps> = ({
  clips,
  output,
}) => {
  const fps = output.fps;
  const outputRatio = output.width / output.height;

  return (
    <AbsoluteFill style={{backgroundColor: "#000"}}>
      <TransitionSeries>
        {clips.flatMap((clip, index) => {
          const transitionBefore =
            index === 0 ? 0 : transitionSeconds(clips[index - 1], clip);
          const handleBefore = clip.source_handle_before_seconds ?? 0;
          const handleAfter = clip.source_handle_after_seconds ?? 0;
          const durationInFrames = Math.max(
            1,
            Math.round(
              (clip.timeline_duration_seconds + handleBefore + handleAfter) * fps,
            ),
          );
          const trimBefore = Math.round((clip.source_in_seconds - handleBefore) * fps);
          const requestedTrimAfter = Math.round(
            (clip.source_out_seconds + handleAfter) * fps,
          );
          const availableTrimAfter = Math.round(clip.source_duration_seconds * fps);
          const sequence = (
            <TransitionSeries.Sequence
              key={`sequence-${clip.id}`}
              durationInFrames={durationInFrames}
            >
              <AbsoluteFill style={{backgroundColor: "#000"}}>
                <OffthreadVideo
                  muted
                  playbackRate={clip.playback_rate ?? 1}
                  src={resolveAsset(clip.source_path)}
                  trimBefore={trimBefore}
                  trimAfter={Math.min(requestedTrimAfter, availableTrimAfter)}
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit:
                      clip.source_width && clip.source_height &&
                      Math.abs(
                        clip.source_width / clip.source_height - outputRatio,
                      ) <= 0.01
                        ? "cover"
                        : "contain",
                  }}
                />
              </AbsoluteFill>
            </TransitionSeries.Sequence>
          );

          if (index === 0 || transitionBefore <= 0) {
            return [sequence];
          }

          return [
            <TransitionSeries.Transition
              key={`transition-${clip.id}`}
              presentation={fade()}
              timing={linearTiming({
                durationInFrames: Math.max(1, Math.round(transitionBefore * fps)),
              })}
            />,
            sequence,
          ];
        })}
      </TransitionSeries>
    </AbsoluteFill>
  );
};
