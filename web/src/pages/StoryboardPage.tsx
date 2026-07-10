import { List, PanelRight } from "lucide-react";
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

type StoryboardView = "list" | "preview" | "inspector";

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
  const [activeView, setActiveView] = useState<StoryboardView>("preview");

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

  const toggleTabletPanel = (view: Exclude<StoryboardView, "preview">) => {
    setActiveView((current) => current === view ? "preview" : view);
  };

  return (
    <section className="storyboard-workspace">
      {plannedShotCount ? (
        <div className="storyboard-planned-status" role="status">
          {strings.storyboardPage.plannedShotCount(plannedShotCount)}
        </div>
      ) : null}

      <div
        className="storyboard-mobile-view-control"
        role="tablist"
        aria-label={strings.storyboardPage.viewControlLabel}
      >
        {([
          ["list", strings.storyboardPage.shotListLabel],
          ["preview", strings.storyboardPage.previewTabLabel],
          ["inspector", strings.storyboardPage.inspectorLabel],
        ] as const).map(([view, label]) => (
          <button
            key={view}
            type="button"
            role="tab"
            aria-selected={activeView === view}
            onClick={() => setActiveView(view)}
          >
            {label}
          </button>
        ))}
      </div>

      <div
        className="storyboard-tablet-controls"
        role="group"
        aria-label={strings.storyboardPage.tabletPanelsLabel}
      >
        <button
          type="button"
          aria-label={strings.storyboardPage.openShotListLabel}
          aria-pressed={activeView === "list"}
          onClick={() => toggleTabletPanel("list")}
        >
          <List aria-hidden="true" size={16} />
          {strings.storyboardPage.shotListLabel}
        </button>
        <button
          type="button"
          aria-label={strings.storyboardPage.openInspectorLabel}
          aria-pressed={activeView === "inspector"}
          onClick={() => toggleTabletPanel("inspector")}
        >
          <PanelRight aria-hidden="true" size={16} />
          {strings.storyboardPage.inspectorLabel}
        </button>
      </div>

      <div className={`storyboard-list-panel${activeView === "list" ? " is-panel-open" : ""}`}>
        <ShotList
          shots={ordered}
          selectedShotId={selectedShot?.id ?? null}
          onSelect={selectShot}
        />
      </div>
      <div className={`storyboard-stage${activeView === "preview" ? " is-panel-open" : ""}`}>
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
      <div className={`storyboard-inspector-panel${activeView === "inspector" ? " is-panel-open" : ""}`}>
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
      </div>
    </section>
  );
}
