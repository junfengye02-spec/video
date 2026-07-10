import type {
  AssetRecord,
  ContinuityPlan,
  ProjectType,
  RenderReport,
  ShortDramaProjectResponse,
  Shot,
} from "../../domain/types";

function isLocalMediaRef(value: string | null | undefined): value is string {
  return typeof value === "string" && value.startsWith("local://media/");
}

function mergeCompatibleMediaList(
  authoritative: string[] | undefined,
  current: string[] | undefined,
): string[] | undefined {
  if (!authoritative || !current) return authoritative;
  return authoritative.map((value, index) => (
    isLocalMediaRef(current[index]) ? current[index] : value
  ));
}

function mergeAssetMedia(
  authoritative: AssetRecord,
  current: AssetRecord | undefined,
): AssetRecord {
  if (!current || current.version !== authoritative.version) return authoritative;
  return {
    ...authoritative,
    reference_images: mergeCompatibleMediaList(
      authoritative.reference_images,
      current.reference_images,
    ) ?? [],
    media_urls: mergeCompatibleMediaList(authoritative.media_urls, current.media_urls),
  };
}

function renderSources(report: RenderReport | null | undefined): Set<string> {
  return new Set(
    (report?.outputs ?? []).flatMap((output) => (
      output.media_url ? [output.path, output.media_url] : [output.path]
    )),
  );
}

function finalRenderIdentityMatches(
  authoritative: ShortDramaProjectResponse,
  current: ShortDramaProjectResponse,
): boolean {
  if (!isLocalMediaRef(current.final_path)) return false;
  const currentSources = renderSources(current.render_report);
  const authoritativeSources = renderSources(authoritative.render_report);
  if (authoritative.final_path && currentSources.has(authoritative.final_path)) return true;
  return Array.from(authoritativeSources).some((source) => currentSources.has(source));
}

export function replaceShotInSnapshot(
  snapshot: ShortDramaProjectResponse,
  shot: Shot,
): ShortDramaProjectResponse {
  return {
    ...snapshot,
    storyboard: {
      ...snapshot.storyboard,
      shots: snapshot.storyboard.shots.map((item) => (item.id === shot.id ? shot : item)),
    },
  };
}

export function mergeAuthoritativeMediaOverlays(
  authoritative: ShortDramaProjectResponse,
  current: ShortDramaProjectResponse,
): ShortDramaProjectResponse {
  const currentShots = new Map(current.storyboard.shots.map((shot) => [shot.id, shot]));
  const currentAssets = new Map((current.series_bible.assets ?? []).map((asset) => [asset.id, asset]));

  return {
    ...authoritative,
    series_bible: {
      ...authoritative.series_bible,
      assets: authoritative.series_bible.assets?.map((asset) => (
        mergeAssetMedia(asset, currentAssets.get(asset.id))
      )),
    },
    storyboard: {
      ...authoritative.storyboard,
      shots: authoritative.storyboard.shots.map((shot) => {
        const currentShot = currentShots.get(shot.id);
        const compatible = currentShot?.version === shot.version
          && isLocalMediaRef(currentShot.output_path)
          && Boolean(shot.output_path || shot.output_url);
        return compatible
          ? { ...shot, output_path: currentShot.output_path, output_url: null }
          : shot;
      }),
    },
    final_path: finalRenderIdentityMatches(authoritative, current)
      ? current.final_path
      : authoritative.final_path,
  };
}

export function emptyContinuityPlan(projectType: ProjectType): ContinuityPlan {
  return {
    project_type: projectType,
    active_episode_number: projectType === "single_video" ? null : 1,
    series_bible: {
      worldview: "",
      main_arc: "",
      style_lock: "",
      visual_rules: "",
      taboos: [],
      locations: [],
      props: [],
      relationship_map: [],
    },
    episodes: [],
    story_state: {
      character_knowledge: [],
      relationship_changes: [],
      active_foreshadowing: [],
      resolved_foreshadowing: [],
      prop_state: [],
      character_status: [],
      current_locations: [],
    },
  };
}
