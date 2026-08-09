import { describe, expect, it } from "vitest";
import { createProjectResponse } from "../test/fixtures";
import { normalizeAndValidateProjectSnapshot } from "./snapshotSchema";

describe("narrative beat snapshot compatibility", () => {
  it("accepts new narrative beat and storyboard constraint fields", () => {
    const snapshot = createProjectResponse();
    snapshot.creative_workflow = {
      phase: "inspiration",
      messages: [],
      brief: {
        title: "Rain Letter",
        logline: "A letter arrives from tomorrow.",
        audience: "Suspense fans",
        format: "single video",
        duration_seconds: 30,
        aspect_ratio: "9:16",
        genre: "mystery",
        tone: "tense",
        visual_style: "rainy neon",
        story_outline: "Arrival, reveal, choice.",
        must_have: [],
        open_questions: [],
        narrative_beats: [{
          id: "beat-1",
          index: 1,
          summary: "The letter arrives.",
          recommended_duration_seconds: 5,
          duration_range_seconds: [4, 6],
          can_merge_with_next: true,
          must_complete_action: false,
          must_preserve_emotion: true,
          cannot_split_reason: null,
        }],
      },
      ready_to_confirm: true,
      planned_asset_ids: [],
      approved_at: null,
    };
    Object.assign(snapshot.storyboard.shots[0], {
      beat_id: "beat-1",
      recommended_duration_seconds: 5,
      duration_range_seconds: [4, 6],
      can_merge_with_next: true,
      must_complete_action: false,
      must_preserve_emotion: true,
      cannot_split_reason: null,
    });

    expect(() => normalizeAndValidateProjectSnapshot(snapshot)).not.toThrow();
  });

  it("continues to accept legacy snapshots without narrative fields", () => {
    expect(() => normalizeAndValidateProjectSnapshot(createProjectResponse())).not.toThrow();
  });

  it("accepts an authoritative generation execution export", () => {
    const snapshot = createProjectResponse();
    snapshot.generation_execution = {
      version: "1.0",
      project_id: snapshot.project.id,
      updated_at: "2026-07-24T12:00:00Z",
      active_generation_unit_ids: ["unit-1"],
      generation_units: [{
        id: "unit-1",
        plan_id: "a".repeat(64),
        revision: 1,
        status: "complete",
        active: true,
        source_shot_ids: [snapshot.storyboard.shots[0].id],
        source_shot_versions: { [snapshot.storyboard.shots[0].id]: 1 },
        source_beat_ids: ["beat-1"],
        source_segment_ids: ["segment-1"],
        prompt_segments: [{
          id: "segment-1",
          source_shot_id: snapshot.storyboard.shots[0].id,
          source_beat_id: "beat-1",
          sequence: 1,
          segment_index: 1,
          segment_count: 1,
          recommended_content_duration_seconds: 5,
          prompt: "Rain falls.",
          transition: "cut",
          continuity_requirements: [],
          start_state: "Rain begins.",
          action_progress: "Rain falls.",
          end_state: "The street is wet.",
        }],
        provider: "newapi",
        model_id: "omni_flash-10s",
        operation: "text_to_video",
        profile_revision: "2026-07-24.1",
        profile: {} as never,
        requested_duration_seconds: 10,
        source_duration_seconds: 10,
        timeline_duration_seconds: 10,
        output_asset_id: null,
        output_path: "assets/video/units/unit-1/v1.mp4",
        task_item_id: null,
        billing_job_id: null,
        replaces_unit_id: null,
        diagnostics: {},
        created_at: "2026-07-24T12:00:00Z",
        updated_at: "2026-07-24T12:00:00Z",
      }],
    };

    expect(() => normalizeAndValidateProjectSnapshot(snapshot)).not.toThrow();
  });

  it("continues to accept legacy generation execution exports", () => {
    const snapshot = createProjectResponse();
    snapshot.generation_execution = {
      version: "1.0",
      project_id: snapshot.project.id,
      updated_at: "2026-07-24T12:00:00Z",
      active_generation_unit_ids: ["unit-1"],
      generation_units: [{
        id: "unit-1",
        plan_id: "a".repeat(64),
        revision: 1,
        status: "complete",
        source_shot_ids: [snapshot.storyboard.shots[0].id],
        source_shot_versions: { [snapshot.storyboard.shots[0].id]: 1 },
        source_beat_ids: ["beat-1"],
        source_segment_ids: [],
        provider: "newapi",
        model_id: "omni_flash-10s",
        operation: "text_to_video",
        requested_duration_seconds: 10,
        source_duration_seconds: 10,
        timeline_duration_seconds: 10,
        output_asset_id: null,
        output_path: "assets/video/units/unit-1/v1.mp4",
        task_item_id: null,
        billing_job_id: null,
        replaces_unit_id: null,
        created_at: "2026-07-24T12:00:00Z",
        updated_at: "2026-07-24T12:00:00Z",
      }],
    };

    expect(() => normalizeAndValidateProjectSnapshot(snapshot)).not.toThrow();
  });
});
