import { cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GenerationPlan, TaskItem } from "../../../domain/types";
import { getStrings } from "../../../i18n";
import { createAcceptedImageTask, createShot } from "../../../test/fixtures";
import { ShotList } from "./ShotList";

vi.mock("../../generation/GenerationModelPicker", () => ({
  GenerationModelPicker: () => null,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ShotList", () => {
  it("keeps thumbnail video sources through StrictMode effect restarts", () => {
    const shot = createShot({ id: "shot-1", output_path: "assets/video/shot-1.mp4" });
    const view = render(
      <StrictMode>
        <ShotList
          shots={[shot]}
          selectedShotId={shot.id}
          resolveShotMedia={() => "/media/shot-1-v1.mp4"}
          onSelect={vi.fn()}
        />
      </StrictMode>,
    );

    const video = view.container.querySelector("video")!;
    expect(video).toHaveAttribute("src", "/media/shot-1-v1.mp4");
    expect(video.src).toContain("/media/shot-1-v1.mp4");
  });

  it("pauses without mutating the React-owned source when a thumbnail unmounts", () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const shot = createShot({ id: "shot-1", output_path: "assets/video/shot-1.mp4" });
    const view = render(
      <ShotList
        shots={[shot]}
        selectedShotId={shot.id}
        resolveShotMedia={() => "/media/shot-1-v1.mp4"}
        onSelect={vi.fn()}
      />,
    );
    const video = view.container.querySelector("video")!;
    Object.defineProperty(video, "paused", { configurable: true, value: false });
    const removeAttribute = vi.spyOn(video, "removeAttribute");

    view.unmount();

    expect(pause).toHaveBeenCalled();
    expect(removeAttribute).not.toHaveBeenCalledWith("src");
    expect(video).toHaveAttribute("src", "/media/shot-1-v1.mp4");
  });

  it("keeps a manual retry action for failed items after automatic retries are exhausted", () => {
    const shot = createShot({ id: "shot-1" });
    const failed: TaskItem = {
      id: "item-1",
      batch_id: "batch-1",
      position: 0,
      task_type: "shot_video.generate",
      status: "failed",
      idempotency_key: "shot-1",
      input: {},
      target_entity_type: "shot_video",
      target_entity_id: shot.id,
      target_entity_version: 1,
      attempt_count: 9,
      max_attempts: 9,
      progress: 0,
      retryable: false,
      error_code: "provider_call_failed",
      error_message: "provider unavailable",
      result: null,
      billing_job_id: null,
      provider_wait_started_at: null,
      provider_next_poll_at: null,
      provider_poll_count: 0,
      dependencies: [],
      created_at: "2026-07-22T00:00:00Z",
      updated_at: "2026-07-22T00:00:00Z",
    };
    const onRetryItem = vi.fn();
    const view = render(
      <ShotList
        shots={[shot]}
        selectedShotId={shot.id}
        resolveShotMedia={() => null}
        onSelect={vi.fn()}
        generationItems={new Map([[shot.id, { batchId: "batch-1", item: failed }]])}
        onRetryItem={onRetryItem}
      />,
    );

    view.getByRole("button", { name: "重试当前分镜" }).click();
    expect(onRetryItem).toHaveBeenCalledWith("batch-1", "item-1");
  });

  it("does not revive the legacy shot regeneration path when no task item exists", () => {
    const shot = createShot({ id: "shot-1", status: "failed" });
    const view = render(
      <ShotList
        shots={[shot]}
        selectedShotId={shot.id}
        resolveShotMedia={() => null}
        onSelect={vi.fn()}
      />,
    );

    expect(view.queryByRole("button", {
      name: getStrings("zh").storyboardPage.retryShotAction,
    })).not.toBeInTheDocument();
  });

  it("shows provider waiting as busy and never offers a retry", () => {
    const shot = createShot({ id: "shot-1" });
    const task = createAcceptedImageTask("batch-1").task;
    const item = task.items![0];
    item.status = "waiting_provider";
    item.target_entity_type = "shot_video";
    item.target_entity_id = shot.id;
    item.retryable = true;
    const onRetryItem = vi.fn();
    const view = render(
      <ShotList
        shots={[shot]}
        selectedShotId={shot.id}
        resolveShotMedia={() => null}
        onSelect={vi.fn()}
        generationItems={new Map([[shot.id, { batchId: task.id, item }]])}
        onRetryItem={onRetryItem}
      />,
    );

    expect(view.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(view.getByText(getStrings("zh").storyboardPage.shotTaskStatusLabels.waiting_provider))
      .toBeInTheDocument();
    expect(view.queryByRole("button", {
      name: getStrings("zh").storyboardPage.retryShotAction,
    })).not.toBeInTheDocument();
    expect(onRetryItem).not.toHaveBeenCalled();
  });

  it("blocks submission until an incompatible native duration is accepted", () => {
    const shot = createShot({ id: "shot-1" });
    const onAccept = vi.fn();
    const plan = {
      version: "1.0",
      id: "a".repeat(64),
      storyboard_revision: "sha256:storyboard",
      provider: "newapi",
      model_id: "omni_flash-10s",
      shot_ids: [shot.id],
      storyboard_shot_count: 1,
      generation_unit_count: 1,
      protected_generation_unit_ids: [],
      pending_shot_ids: [shot.id],
      covered_shot_ids: [shot.id],
      covered_segment_ids: [],
      can_generate: false,
      requires_confirmation: true,
      compatible_with_target: false,
      native_total_duration_seconds: 10,
      target_duration_seconds: 5,
      timeline_total_duration_seconds: 10,
      duration_difference_seconds: 5,
      confirmed_strategy: null,
      adaptation_options: ["accept_longer_duration"],
      issues: [{
        code: "target_duration_incompatible",
        message: "10s instead of 5s",
        shot_id: null,
        unit_id: null,
      }],
      generation_segments: [],
      generation_units: [{
        id: "unit-1",
        revision: 1,
        status: "planned",
        shot_ids: [shot.id],
        source_shot_ids: [shot.id],
        source_beat_ids: [shot.id],
        source_segment_ids: [],
        prompt_segments: [],
        provider: "newapi",
        model_id: "omni_flash-10s",
        operation: "text_to_video",
        requested_duration_seconds: 10,
        source_duration_seconds: null,
        timeline_duration_seconds: 10,
        output_asset_id: null,
        output_path: null,
        billing_job_id: null,
        task_item_id: null,
        replaces_unit_id: null,
        profile: {
          provider: "newapi",
          model_id: "omni_flash-10s",
          operation: "text_to_video",
          duration_mode: "fixed",
          fixed_duration_seconds: 10,
          supported_duration_seconds: [],
          min_duration_seconds: null,
          max_duration_seconds: null,
          supports_start_frame: false,
          supports_end_frame: false,
          supports_extend: false,
          supports_sequential_beats: true,
          supports_multi_shot_prompt: true,
          max_narrative_beats_per_unit: 2,
          contract_source: "verified_override",
          profile_revision: "test",
          duration_configuration_status: "configured",
        },
      }],
    } satisfies GenerationPlan;
    const onGenerate = vi.fn();
    const view = render(
      <ShotList
        shots={[shot]}
        selectedShotId={shot.id}
        resolveShotMedia={() => null}
        onSelect={vi.fn()}
        onGeneratePendingUnits={onGenerate}
        generationPlan={plan}
        onAcceptLongerDuration={onAccept}
      />,
    );

    expect(view.getByRole("button", {
      name: getStrings("zh").storyboardPage.generatePendingUnitsAction(1),
    })).toBeDisabled();
    view.getByRole("button", {
      name: getStrings("zh").storyboardPage.acceptLongerDurationAction,
    }).click();
    expect(onAccept).toHaveBeenCalledTimes(1);
  });
});
