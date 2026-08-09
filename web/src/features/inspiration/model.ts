import type { CreativeBrief, ProjectType } from "../../domain/types";

export type InspirationSuggestion = {
  label: string;
  value: string;
};

function promptLine(label: string, value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? `${label}: ${normalized}` : null;
}

export function creativeBriefToPrompt(
  brief: CreativeBrief,
  projectType: ProjectType = "single_video",
): string {
  const lines = [
    promptLine("Project type", projectType),
    promptLine("Title", brief.title),
    promptLine("Logline", brief.logline),
    promptLine("Audience", brief.audience),
    promptLine("Format", brief.format),
    brief.duration_seconds ? promptLine("Duration", `${brief.duration_seconds} seconds`) : null,
    promptLine("Aspect ratio", brief.aspect_ratio),
    promptLine("Genre", brief.genre),
    promptLine("Tone", brief.tone),
    promptLine("Visual style", brief.visual_style),
    promptLine("Story outline", brief.story_outline),
    brief.must_have.length ? promptLine("Must include", brief.must_have.join("; ")) : null,
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

const DEFAULT_SUGGESTIONS: Record<ProjectType, InspirationSuggestion[]> = {
  single_video: [
    { label: "补充观众感受", value: "我希望观众看完后最强烈的感受是：" },
    { label: "梳理故事转折", value: "故事里最关键的转折是：" },
    { label: "明确视觉方向", value: "我希望整体画面的质感和视觉方向是：" },
  ],
  mini_series: [
    { label: "明确短系列主线", value: "这个短系列贯穿各集的核心主线是：" },
    { label: "设计单集钩子", value: "每集结尾推动下一集的钩子应该是：" },
    { label: "梳理人物变化", value: "人物关系在这个短系列中的关键变化是：" },
  ],
  long_series: [
    { label: "明确季级主线", value: "这个长系列贯穿整季的核心主线是：" },
    { label: "规划阶段转折", value: "整季中段和收束阶段的关键转折是：" },
    { label: "梳理长期关系", value: "人物关系跨集演变的主要路径是：" },
  ],
};

export function suggestionsFor(
  brief: CreativeBrief | null,
  projectType: ProjectType = "single_video",
): InspirationSuggestion[] {
  const questions = brief?.open_questions.filter((question) => question.trim()).slice(0, 3) ?? [];
  if (!questions.length) return DEFAULT_SUGGESTIONS[projectType];
  return questions.map((question) => ({
    label: question,
    value: `关于“${question}”，我的回答是：`,
  }));
}
