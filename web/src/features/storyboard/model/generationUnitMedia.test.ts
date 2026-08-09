import { describe, expect, it } from "vitest";
import type {
  GenerationExecutionSnapshot,
  GenerationExecutionUnit,
} from "../../../domain/types";
import {
  generationUnitMediaForShot,
  outdatedGenerationUnitIdsForShots,
} from "./generationUnitMedia";

function unit(
  id: string,
  sequence: number,
  status: GenerationExecutionUnit["status"] = "complete",
): GenerationExecutionUnit {
  return {
    id,
    plan_id: "plan",
    revision: 1,
    status,
    active: status === "complete",
    source_shot_ids: ["shot-1"],
    source_shot_versions: { "shot-1": 1 },
    source_beat_ids: ["beat-1"],
    source_segment_ids: [`segment-${sequence}`],
    prompt_segments: [{
      id: `segment-${sequence}`,
      source_shot_id: "shot-1",
      source_beat_id: "beat-1",
      sequence,
      segment_index: sequence,
      segment_count: 2,
      recommended_content_duration_seconds: 5,
      prompt: `Segment ${sequence}`,
      transition: "continuous",
      continuity_requirements: [],
      start_state: "start",
      action_progress: "action",
      end_state: "end",
    }],
    provider: "newapi",
    model_id: "omni_flash-10s",
    operation: "text_to_video",
    requested_duration_seconds: 10,
    source_duration_seconds: status === "complete" ? 10 : null,
    timeline_duration_seconds: 10,
    output_asset_id: status === "complete" ? `asset-${id}` : null,
    output_path: status === "complete" ? `assets/video/units/${id}/v1.mp4` : null,
    task_item_id: `item-${id}`,
    billing_job_id: null,
    replaces_unit_id: null,
    created_at: `2026-08-04T00:00:0${3 - sequence}Z`,
    updated_at: "2026-08-04T00:00:00Z",
  };
}

function execution(units: GenerationExecutionUnit[]): GenerationExecutionSnapshot {
  return {
    version: "1.0",
    project_id: "p1",
    updated_at: "2026-08-04T00:00:00Z",
    active_generation_unit_ids: units
      .filter((candidate) => candidate.status === "complete")
      .map((candidate) => candidate.id),
    generation_units: units,
  };
}

describe("generationUnitMediaForShot", () => {
  it("orders active media by prompt sequence instead of ledger order", () => {
    const result = generationUnitMediaForShot(
      execution([unit("unit-2", 2), unit("unit-1", 1)]),
      "shot-1",
      (path) => `/api/projects/p1/media/${path}`,
    );

    expect(result).toEqual({
      complete: true,
      hasUnits: true,
      urls: [
        "/api/projects/p1/media/assets/video/units/unit-1/v1.mp4",
        "/api/projects/p1/media/assets/video/units/unit-2/v1.mp4",
      ],
    });
  });

  it("keeps coverage incomplete while a segment is still pending", () => {
    const result = generationUnitMediaForShot(
      execution([unit("unit-1", 1), unit("unit-2", 2, "waiting_provider")]),
      "shot-1",
      (path) => `/api/projects/p1/media/${path}`,
    );

    expect(result.urls).toHaveLength(1);
    expect(result.complete).toBe(false);
    expect(result.hasUnits).toBe(true);
  });

  it("does not treat an unresolvable output path as reusable media", () => {
    const result = generationUnitMediaForShot(
      execution([unit("unit-1", 1)]),
      "shot-1",
      () => null,
    );

    expect(result).toEqual({ complete: false, hasUnits: true, urls: [] });
  });

  it("retains old media for preview without treating it as reusable after a shot edit", () => {
    const result = generationUnitMediaForShot(
      execution([unit("unit-1", 1)]),
      "shot-1",
      (path) => `/api/projects/p1/media/${path}`,
      2,
    );

    expect(result).toEqual({
      complete: false,
      hasUnits: true,
      urls: ["/api/projects/p1/media/assets/video/units/unit-1/v1.mp4"],
    });
  });

  it("identifies the complete active units whose source shot versions are outdated", () => {
    const first = unit("unit-1", 1);
    const second = unit("unit-2", 2);
    second.source_shot_versions = { "shot-1": 2 };

    expect(outdatedGenerationUnitIdsForShots(
      execution([first, second]),
      [{ id: "shot-1", version: 2 }],
    )).toEqual(new Set(["unit-1"]));
  });
});
