import type {
  GenerationExecutionSnapshot,
  GenerationExecutionUnit,
  Shot,
} from "../../../domain/types";

export interface ShotGenerationUnitMedia {
  complete: boolean;
  hasUnits: boolean;
  urls: string[];
}

type MediaPathResolver = (path: string) => string | null;

function segmentKeys(unit: GenerationExecutionUnit, shotId: string): string[] {
  const promptSegments = (unit.prompt_segments ?? [])
    .filter((segment) => segment.source_shot_id === shotId);
  if (promptSegments.length) {
    return promptSegments.map((segment) => `segment:${segment.id}`);
  }
  if (unit.source_shot_ids.length === 1 && unit.source_segment_ids.length) {
    return unit.source_segment_ids.map((segmentId) => `segment:${segmentId}`);
  }
  return [`unit:${unit.id}`];
}

function sequenceForShot(unit: GenerationExecutionUnit, shotId: string): number {
  const sequences = (unit.prompt_segments ?? [])
    .filter((segment) => segment.source_shot_id === shotId)
    .map((segment) => segment.sequence)
    .filter(Number.isFinite);
  return sequences.length ? Math.min(...sequences) : Number.MAX_SAFE_INTEGER;
}

export function generationUnitMediaForShot(
  execution: GenerationExecutionSnapshot | null | undefined,
  shotId: string,
  resolvePath: MediaPathResolver,
  shotVersion?: number,
): ShotGenerationUnitMedia {
  if (!execution) return { complete: false, hasUnits: false, urls: [] };

  const relevant = execution.generation_units.filter((unit) => (
    unit.status !== "stale" && unit.source_shot_ids.includes(shotId)
  ));
  if (!relevant.length) return { complete: false, hasUnits: false, urls: [] };

  const current = shotVersion === undefined
    ? relevant
    : relevant.filter((unit) => unit.source_shot_versions[shotId] === shotVersion);

  const activeIds = new Set(execution.active_generation_unit_ids);
  const active = current
    .map((unit) => ({
      unit,
      url: unit.output_path ? resolvePath(unit.output_path) : null,
    }))
    .filter((item): item is { unit: GenerationExecutionUnit; url: string } => Boolean(
      activeIds.has(item.unit.id)
      && item.unit.active !== false
      && item.unit.status === "complete"
      && item.url,
    ))
    .sort((left, right) => (
      sequenceForShot(left.unit, shotId) - sequenceForShot(right.unit, shotId)
      || Date.parse(left.unit.created_at) - Date.parse(right.unit.created_at)
      || left.unit.id.localeCompare(right.unit.id)
      || left.unit.revision - right.unit.revision
    ));

  // Keep the last successful video visible while a saved storyboard revision is
  // waiting for replacement. It is preview-only and never counts as reusable.
  const retained = active.length || shotVersion === undefined
    ? []
    : relevant
      .map((unit) => ({
        unit,
        url: unit.output_path ? resolvePath(unit.output_path) : null,
      }))
      .filter((item): item is { unit: GenerationExecutionUnit; url: string } => Boolean(
        activeIds.has(item.unit.id)
        && item.unit.active !== false
        && item.unit.status === "complete"
        && item.url,
      ))
      .sort((left, right) => (
        sequenceForShot(left.unit, shotId) - sequenceForShot(right.unit, shotId)
        || Date.parse(left.unit.created_at) - Date.parse(right.unit.created_at)
        || left.unit.id.localeCompare(right.unit.id)
        || left.unit.revision - right.unit.revision
      ));

  const expectedKeys = new Set(current.flatMap((unit) => segmentKeys(unit, shotId)));
  const coveredKeys = new Set(active.flatMap(({ unit }) => segmentKeys(unit, shotId)));
  const urls = Array.from(new Set((active.length ? active : retained).map(({ url }) => url)));

  return {
    complete: expectedKeys.size > 0
      && urls.length > 0
      && [...expectedKeys].every((key) => coveredKeys.has(key)),
    hasUnits: true,
    urls,
  };
}

export function outdatedGenerationUnitIdsForShots(
  execution: GenerationExecutionSnapshot | null | undefined,
  shots: Pick<Shot, "id" | "version">[],
): Set<string> {
  if (!execution) return new Set();
  const versions = new Map(shots.map((shot) => [shot.id, shot.version]));
  const activeIds = new Set(execution.active_generation_unit_ids);
  return new Set(
    execution.generation_units
      .filter((unit) => (
        unit.status === "complete"
        && (unit.active === true || (unit.active !== false && activeIds.has(unit.id)))
        && unit.source_shot_ids.some((shotId) => (
          versions.has(shotId)
          && unit.source_shot_versions[shotId] !== versions.get(shotId)
        ))
      ))
      .map((unit) => unit.id),
  );
}
