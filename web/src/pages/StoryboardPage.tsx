import { useEffect, useMemo, useState } from "react";
import { ShotEditor } from "../components/ShotEditor";
import { ShotList } from "../components/storyboard/ShotList";
import { ShotOrderStrip } from "../components/storyboard/ShotOrderStrip";
import { ShotPreview } from "../components/storyboard/ShotPreview";
import { orderedShots } from "../domain/storyboard";
import type {
  AssetRecord,
  Character,
  PromptOptimizeResponse,
  Shot,
  ShotSaveRequest,
} from "../domain/types";
import { getStrings } from "../i18n";

export interface StoryboardPageProps {
  assets: AssetRecord[];
  characters: Character[];
  optimizingShotId: string | null;
  regeneratingShotId: string | null;
  savingShotId: string | null;
  selectedShotId: string | null;
  shots: Shot[];
  plannedShotCount?: number | null;
  resolveShotMedia: (shot: Shot) => string | null;
  onSelectShot: (shotId: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onOptimizePrompt: (shot: Shot, sourceText: string) => Promise<PromptOptimizeResponse>;
  onSaveShot: (shotId: string, payload: ShotSaveRequest) => Promise<void>;
  onRegenerateShot: (shot: Shot) => Promise<void>;
}

export function StoryboardPage({
  assets,
  characters,
  optimizingShotId,
  regeneratingShotId,
  savingShotId,
  selectedShotId,
  shots,
  plannedShotCount = null,
  resolveShotMedia,
  onSelectShot,
  onDirtyChange,
  onOptimizePrompt,
  onSaveShot,
  onRegenerateShot,
}: StoryboardPageProps) {
  const strings = getStrings("zh");
  const ordered = useMemo(() => orderedShots(shots), [shots]);
  const selectedShot = ordered.find((shot) => shot.id === selectedShotId) ?? ordered[0] ?? null;
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  useEffect(() => {
    if (!dirty) {
      return;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty]);

  const selectShot = (shotId: string) => {
    if (shotId === selectedShot?.id) {
      return;
    }
    if (dirty && !window.confirm(strings.storyboardPage.discardChangesConfirm)) {
      return;
    }
    onSelectShot(shotId);
  };

  return (
    <section className="storyboard-workspace">
      {plannedShotCount ? (
        <div role="status">{strings.storyboardPage.plannedShotCount(plannedShotCount)}</div>
      ) : null}
      <ShotList
        shots={ordered}
        selectedShotId={selectedShot?.id ?? null}
        onSelect={selectShot}
      />
      <div className="storyboard-stage">
        <ShotPreview
          shot={selectedShot}
          mediaUrl={selectedShot ? resolveShotMedia(selectedShot) : null}
        />
        <ShotOrderStrip
          shots={ordered}
          selectedShotId={selectedShot?.id ?? null}
          onSelect={selectShot}
        />
      </div>
      <ShotEditor
        assets={assets}
        characters={characters}
        optimizing={optimizingShotId === selectedShot?.id}
        regenerating={regeneratingShotId === selectedShot?.id}
        saving={savingShotId === selectedShot?.id}
        shot={selectedShot}
        strings={{
          ...strings.shotEditor,
          regionLabel: strings.storyboardPage.inspectorLabel,
        }}
        onDirtyChange={setDirty}
        onOptimizePrompt={onOptimizePrompt}
        onSaveShot={onSaveShot}
        onRegenerateShot={onRegenerateShot}
      />
    </section>
  );
}
