import { describe, expect, it } from "vitest";

import { createProjectResponse } from "../../test/fixtures";
import { blueprintDocuments } from "./blueprintModel";

describe("blueprintDocuments", () => {
  it("uses the latest character visual lock when a legacy asset prompt is stale", () => {
    const snapshot = createProjectResponse();
    snapshot.series_bible.characters[0].visual_lock = "European man, age 24, medium fair skin";
    snapshot.series_bible.assets![0].prompt = "European man, 29";

    const character = blueprintDocuments(snapshot).characters.entries[0];
    const appearanceLock = character.fields.find((field) => field.label === "外貌锁定");
    const characterPrompt = character.fields.find((field) => field.label === "人物提示词");

    expect(appearanceLock?.value).toBe("European man, age 24, medium fair skin");
    expect(characterPrompt?.value).toBe(appearanceLock?.value);
  });
});
