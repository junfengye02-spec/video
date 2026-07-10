import { describe, expect, it } from "vitest";

// @ts-expect-error The Vitest runtime provides Node built-ins, but the browser tsconfig omits them.
import { readFileSync } from "node:fs";

const pagesCss = readFileSync("src/styles/pages.css", "utf8");
const responsiveCss = readFileSync("src/styles/responsive.css", "utf8");

function ruleBody(source: string, selector: string): string {
  const selectorIndex = source.indexOf(selector);
  if (selectorIndex < 0) return "";

  const openBraceIndex = source.indexOf("{", selectorIndex + selector.length);
  if (openBraceIndex < 0) return "";

  const closeBraceIndex = source.indexOf("}", openBraceIndex + 1);
  return closeBraceIndex < 0 ? "" : source.slice(openBraceIndex + 1, closeBraceIndex);
}

describe("responsive CSS contracts", () => {
  it("does not transition tablet panel visibility while focus moves into an opening panel", () => {
    const tabletCss = responsiveCss.slice(
      responsiveCss.indexOf("@media (max-width: 1179px)"),
      responsiveCss.indexOf("@media (max-width: 767px)"),
    );
    const fixedPanels = ruleBody(tabletCss, ".storyboard-shot-list,");

    expect(fixedPanels).toContain("transition: transform 160ms ease;");
    expect(fixedPanels).not.toContain("visibility 160ms ease");
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
});
