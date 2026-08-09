import { describe, expect, it } from "vitest";

// @ts-expect-error Vitest exposes Node built-ins while the browser tsconfig omits them.
import { readFileSync } from "node:fs";

const sharedSources = [
  "src/shared/motion/primitives.tsx",
  "src/shared/motion/useReducedMotion.ts",
  "src/shared/ui/Button.tsx",
  "src/shared/ui/Dialog.tsx",
  "src/shared/ui/Drawer.tsx",
  "src/shared/ui/Menu.tsx",
  "src/shared/ui/Surface.tsx",
  "src/shared/ui/Tabs.tsx",
  "src/shared/ui/Tooltip.tsx",
  "src/shared/ui/useOverlayFocus.ts",
];

const foundationCss = [
  "src/shared/styles/tokens.css",
  "src/shared/styles/reset.css",
  "src/shared/styles/typography.css",
  "src/shared/styles/motion.css",
  "src/shared/styles/utilities.css",
  "src/shared/motion/Motion.module.css",
  "src/shared/ui/Controls.module.css",
  "src/shared/ui/Overlays.module.css",
  "src/shared/ui/Surface.module.css",
];

const creativeFeatureCss = [
  "src/features/inspiration/InspirationPage.module.css",
  "src/features/inspiration/components/Conversation.module.css",
  "src/features/inspiration/components/CreativeBrief.module.css",
  "src/features/inspiration/components/InspirationComposer.module.css",
  "src/features/blueprint/BlueprintWorkspace.module.css",
  "src/features/blueprint/BlueprintDocument.module.css",
  "src/features/blueprint/BlueprintOverlays.module.css",
];

describe("shared frontend foundation", () => {
  it("keeps shared independent from app, pages and feature internals", () => {
    const violations = sharedSources.flatMap((path) => {
        const source = readFileSync(path, "utf8");
        return /from\s+["'][^"']*\/(?:app|features|pages)\//.test(source)
          ? [path]
          : [];
      });
    expect(violations).toEqual([]);
  });

  it("centralizes motion and avoids transition all in the new foundation", () => {
    const css = [...foundationCss, ...creativeFeatureCss]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(css).not.toMatch(/transition\s*:\s*all\b/i);
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("--duration-panel");
    expect(css).toContain("--z-dialog");
  });

  it("keeps new CSS modules below the first-batch review threshold", () => {
    const modules = [
      "src/components/projects/ProjectCard.module.css",
      "src/components/shell/AppShell.module.css",
      "src/pages/ProjectsPage.module.css",
      ...foundationCss.filter((path) => path.endsWith(".module.css")),
      ...creativeFeatureCss,
    ];
    const oversized = modules
      .filter((path) => readFileSync(path, "utf8").split(/\r?\n/).length >= 300)
      .map((path) => path);
    expect(oversized).toEqual([]);
  });

  it("keeps migrated inspiration and blueprint selectors out of legacy page styles", () => {
    const legacy = ["src/styles/pages.css", "src/styles/responsive.css"]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(legacy).not.toMatch(/\.(?:inspiration-page|inspiration-composer|conversation-panel|creative-brief-panel|blueprint-review-page|blueprint-workspace|blueprint-document-canvas)\b/);
  });

  it("contains responsive guards for 390, 1024, 1440 and 1600 layouts", () => {
    const shell = readFileSync("src/components/shell/AppShell.module.css", "utf8");
    const projects = readFileSync("src/pages/ProjectsPage.module.css", "utf8");
    const cards = readFileSync("src/components/projects/ProjectCard.module.css", "utf8");
    expect(shell).toContain("overflow-x: clip");
    expect(projects).toContain("minmax(min(260px, 100%), 1fr)");
    expect(projects).toContain("@media (min-width: 1440px)");
    expect(cards).toContain("aspect-ratio: 16 / 9");
  });
});
