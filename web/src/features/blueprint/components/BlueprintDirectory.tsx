import {
  Check,
  ChevronRight,
  Circle,
  Clapperboard,
  Globe2,
  Map,
  Music2,
  Package,
  RefreshCw,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import {
  BLUEPRINT_SECTION_COPY,
  PLAN_SECTION_IDS,
  type BlueprintDocument,
} from "../../../components/blueprint/blueprintModel";
import type { PlanSectionApproval, PlanSectionId } from "../../../domain/types";
import { blueprintCopy as copy } from "../copy";
import styles from "../BlueprintWorkspace.module.css";

const ICONS: Record<PlanSectionId, LucideIcon> = {
  worldview: Globe2,
  characters: Users,
  scenes: Map,
  props: Package,
  sound: Music2,
  storyboard: Clapperboard,
};

const STATUS_COPY: Record<PlanSectionApproval["status"], string> = {
  pending: "待确认",
  approved: "已确认",
  changes_requested: "修改中",
};

export function BlueprintDirectory({
  active,
  activeSection,
  documents,
  onSelect,
  sections,
}: {
  active: boolean;
  activeSection: PlanSectionId;
  documents: Record<PlanSectionId, BlueprintDocument>;
  onSelect: (section: PlanSectionId) => void;
  sections: Record<PlanSectionId, PlanSectionApproval>;
}) {
  return (
    <aside className={styles.directory} aria-label="蓝图目录" data-mobile-active={active}>
      <header>
        <span>蓝图目录</span>
        <h2>{copy.planningComplete}</h2>
        <p>{copy.planningSource}</p>
      </header>
      <div className={styles.runSummary}>
        <ShieldCheck aria-hidden="true" size={16} />
        <span><strong>只包含文本规划</strong><small>确认完成前不会解锁媒体制作</small></span>
      </div>
      <nav className={styles.directoryList} aria-label="蓝图分类">
        {PLAN_SECTION_IDS.map((section) => {
          const Icon = ICONS[section];
          const approval = sections[section];
          const document = documents[section];
          return (
            <button
              key={section}
              type="button"
              data-active={activeSection === section}
              aria-current={activeSection === section ? "page" : undefined}
              onClick={() => onSelect(section)}
            >
              <span className={styles.directoryIcon}><Icon aria-hidden="true" size={17} /></span>
              <span className={styles.directoryCopy}>
                <strong>{BLUEPRINT_SECTION_COPY[section].label}</strong>
                <small data-status={approval.status}>
                  {approval.status === "approved" ? <Check aria-hidden="true" size={12} /> : approval.status === "changes_requested" ? <RefreshCw aria-hidden="true" size={12} /> : <Circle aria-hidden="true" size={9} />}
                  {STATUS_COPY[approval.status]} · {document.count} 项
                </small>
              </span>
              <ChevronRight aria-hidden="true" size={15} />
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
