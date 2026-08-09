import type {
  GenerationExecutionSnapshot,
  GenerationExecutionUnit,
  Shot,
} from "../../../domain/types";

export interface GenerationUnitPreviewItem {
  key: string;
  mediaUrl: string | null;
  sourceShots: Shot[];
  unit: GenerationExecutionUnit;
}

type MediaPathResolver = (path: string) => string | null;

function unitSequence(unit: GenerationExecutionUnit): number {
  const sequences = (unit.prompt_segments ?? [])
    .map((segment) => segment.sequence)
    .filter(Number.isFinite);
  return sequences.length ? Math.min(...sequences) : Number.MAX_SAFE_INTEGER;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function generationUnitPreviewItems(
  execution: GenerationExecutionSnapshot | null | undefined,
  shots: Shot[],
  resolvePath: MediaPathResolver,
): GenerationUnitPreviewItem[] {
  if (!execution) return [];
  const shotsById = new Map(shots.map((shot) => [shot.id, shot]));
  const scopedShotIds = new Set(shotsById.keys());
  const activeIds = new Set(execution.active_generation_unit_ids);

  return execution.generation_units
    .filter((unit) => (
      unit.status === "complete"
      && unit.output_path
      && unit.active !== false
      && activeIds.has(unit.id)
      && unit.source_shot_ids.some((shotId) => scopedShotIds.has(shotId))
    ))
    .map((unit) => ({
      key: `${unit.id}:${unit.revision}`,
      mediaUrl: unit.output_path ? resolvePath(unit.output_path) : null,
      sourceShots: unit.source_shot_ids
        .map((shotId) => shotsById.get(shotId))
        .filter((shot): shot is Shot => Boolean(shot)),
      unit,
    }))
    .sort((left, right) => (
      unitSequence(left.unit) - unitSequence(right.unit)
      || timestamp(left.unit.created_at) - timestamp(right.unit.created_at)
      || left.unit.id.localeCompare(right.unit.id)
      || left.unit.revision - right.unit.revision
    ));
}
