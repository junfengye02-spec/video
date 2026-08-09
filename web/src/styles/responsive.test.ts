import { describe, expect, it } from "vitest";

// @ts-expect-error The Vitest runtime provides Node built-ins, but the browser tsconfig omits them.
import { readFileSync } from "node:fs";

const pagesCss = readFileSync("src/styles/pages.css", "utf8");
const responsiveCss = readFileSync("src/styles/responsive.css", "utf8");
const globalCss = readFileSync("src/styles.css", "utf8");
const shellCss = readFileSync("src/styles/shell.css", "utf8");
const storyboardCss = readFileSync("src/features/storyboard/StoryboardWorkbench.module.css", "utf8");
const mediaStageCss = readFileSync("src/features/storyboard/components/MediaStage.module.css", "utf8");
const shotInspectorCss = readFileSync("src/features/storyboard/components/ShotInspector.module.css", "utf8");
const appComposition = readFileSync("src/app/AppComposition.tsx", "utf8");

function ruleBody(source: string, selector: string): string {
  const selectorIndex = source.indexOf(selector);
  if (selectorIndex < 0) return "";

  const openBraceIndex = source.indexOf("{", selectorIndex + selector.length);
  if (openBraceIndex < 0) return "";

  const closeBraceIndex = source.indexOf("}", openBraceIndex + 1);
  return closeBraceIndex < 0 ? "" : source.slice(openBraceIndex + 1, closeBraceIndex);
}

describe("responsive CSS contracts", () => {
  it("keeps compact storyboard panels mounted while showing only the selected segment", () => {
    const compactCss = storyboardCss.slice(storyboardCss.indexOf("@media (max-width: 1179px)"));
    const inactivePane = ruleBody(compactCss, '.pane[data-active="false"]');

    expect(inactivePane).toContain("display: none;");
    expect(storyboardCss).not.toContain("visibility 160ms ease");
  });

  it("gives the mobile shell a content-height navigation row and a remaining-space content row", () => {
    const mobileCss = responsiveCss.slice(responsiveCss.indexOf("@media (max-width: 767px)"));
    const workbenchBody = ruleBody(mobileCss, ".workbench-body");

    expect(workbenchBody).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(workbenchBody).toContain("grid-template-rows: auto minmax(0, 1fr);");
  });

  it("keeps mobile async project actions stable while ordinary actions can shrink", () => {
    const mobileCss = responsiveCss.slice(responsiveCss.indexOf("@media (max-width: 767px)"));
    const projectActions = ruleBody(mobileCss, ".project-actions a,");
    const asyncProjectActions = ruleBody(mobileCss, ".project-actions .async-action");

    expect(projectActions).toContain("min-inline-size: 0;");
    expect(asyncProjectActions).toContain("min-inline-size: 9.75rem;");
  });

  it("keeps async label changes within a stable inline-size contract", () => {
    const asyncAction = ruleBody(pagesCss, ".async-action");

    expect(asyncAction).toContain("min-inline-size: 9.75rem;");
    expect(asyncAction).toContain("white-space: nowrap;");
  });

  it("keeps the global settings directory inside a 390px viewport", () => {
    const compactCss = responsiveCss.slice(responsiveCss.indexOf("@media (max-width: 520px)"));
    const directoryNav = ruleBody(compactCss, ".settings-directory nav");
    const directoryButton = ruleBody(compactCss, ".settings-directory nav button");

    expect(directoryNav).toContain("width: 100%;");
    expect(directoryNav).toContain("grid-template-columns: repeat(2, minmax(0, 1fr));");
    expect(directoryButton).toContain("min-width: 0;");
    expect(directoryButton).toContain("width: 100%;");
  });

  it("stops spinner motion while preserving static loading indicators", () => {
    const reducedMotion = globalCss.slice(globalCss.indexOf("@media (prefers-reduced-motion: reduce)"));

    expect(reducedMotion).toContain(".mise-spinner");
    expect(reducedMotion).toContain(".asset-media-frame[data-media-state=\"loading\"] .asset-media-state svg");
    expect(reducedMotion).toContain(".production-preview-spinner");
    expect(reducedMotion).toContain("animation: none !important;");
    expect(reducedMotion).toContain("transform: none !important;");
  });

  it("lets the storyboard preview preserve its declared ratio inside height-constrained panels", () => {
    const previewCanvas = ruleBody(mediaStageCss, ".canvas");

    expect(previewCanvas).toContain("width: min(100%, 1180px);");
    expect(previewCanvas).toContain("height: auto;");
    expect(previewCanvas).toContain("max-width: min(100%, 1180px);");
  });

  it("stacks keyframe actions by inspector width and keeps every action inside its grid cell", () => {
    const keyframeActions = ruleBody(shotInspectorCss, ".keyframeActions");
    const actionButtons = ruleBody(shotInspectorCss, ".keyframeActions > button");
    const narrowInspector = shotInspectorCss.slice(
      shotInspectorCss.indexOf("@container shot-inspector"),
    );

    expect(keyframeActions).toContain("grid-template-columns: repeat(2, minmax(0, 1fr));");
    expect(actionButtons).toContain("width: 100%;");
    expect(actionButtons).toContain("min-width: 0;");
    expect(narrowInspector).toContain("@container shot-inspector (max-width: 340px)");
    expect(ruleBody(narrowInspector, ".keyframeActions")).toContain(
      "grid-template-columns: minmax(0, 1fr);",
    );
  });

  it("keeps compact production and project context text above the muted contrast floor", () => {
    expect(shellCss).toContain(
      ".workbench-project-context span {\n  color: var(--mise-muted);",
    );
    expect(ruleBody(pagesCss, ".production-step-list li")).toContain("color: var(--mise-muted);");
    expect(ruleBody(pagesCss, ".production-connection")).toContain("color: var(--mise-muted);");
    expect(ruleBody(pagesCss, ".production-evidence .workflow-list small")).toContain("color: var(--mise-muted);");
  });

  it("enables supported router future flags in the production composition", () => {
    expect(appComposition).toContain(
      'future={{ v7_relativeSplatPath: true, v7_startTransition: true }}',
    );
  });
});
