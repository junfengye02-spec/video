import { ArrowRight, Download, Film, MoreHorizontal, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { projectRoutes } from "../../app/routes";
import type { LocalProjectSummary, LocalMediaRef } from "../../localdb/types";
import { mediaRepository } from "../../platform/storage/MediaRepository";
import { IconButton, Menu, MenuItem, Tooltip } from "../../shared/ui";
import { getStrings } from "../../i18n";
import styles from "./ProjectCard.module.css";

function isLocalMediaRef(value: string): value is LocalMediaRef {
  return value.startsWith("local://media/");
}

function useProjectCoverUrl(project: LocalProjectSummary): string | null {
  const [url, setUrl] = useState<string | null>(() => (
    project.cover && !isLocalMediaRef(project.cover.source)
      ? mediaRepository.remoteUrl(project.cover.source, project.id)
      : null
  ));

  useEffect(() => {
    let active = true;
    if (!project.cover) {
      setUrl(null);
      return () => { active = false; };
    }
    if (!isLocalMediaRef(project.cover.source)) {
      setUrl(mediaRepository.remoteUrl(project.cover.source, project.id));
      return () => { active = false; };
    }
    void mediaRepository.resolve(project.cover.source)
      .then((resolved) => { if (active) setUrl(resolved); })
      .catch(() => { if (active) setUrl(null); });
    return () => { active = false; };
  }, [project.cover, project.id]);

  return url;
}

export function ProjectCard({
  exporting,
  onDelete,
  onExport,
  project,
}: {
  exporting: boolean;
  onDelete: (project: LocalProjectSummary, opener: HTMLButtonElement) => void;
  onExport: (project: LocalProjectSummary) => void;
  project: LocalProjectSummary;
}) {
  const coverUrl = useProjectCoverUrl(project);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const strings = getStrings("zh").projectsPage;
  const openLabel = strings.openProject(project.title);
  const status = project.hasFinalRender ? "已有成片" : "未生成成片";

  return (
    <li className={`${styles.card} project-item`}>
      <Link className={styles.coverLink} to={projectRoutes.storyboard(project.id)} aria-label={`预览并打开 ${project.title}`}>
        <span className={styles.cover}>
          {coverUrl && project.cover?.kind === "image" ? <img src={coverUrl} alt="" /> : null}
          {coverUrl && project.cover?.kind === "video" ? (
            <video src={coverUrl} muted playsInline preload="metadata" aria-hidden="true" />
          ) : null}
          {!coverUrl ? <Film size={26} strokeWidth={1.5} aria-hidden="true" /> : null}
          <span className={styles.status}>{status}</span>
        </span>
      </Link>
      <div className={styles.body}>
        <div className={styles.heading}>
          <div className={styles.copy}>
            <h3 title={project.title}>{project.title}</h3>
            <p>{strings.shotCount(project.shotCount)}</p>
          </div>
          <Menu
            label={`${project.title} 项目操作`}
            trigger={(triggerProps) => (
              <Tooltip content="更多操作">
                <IconButton
                  {...triggerProps}
                  ref={(node) => {
                    triggerProps.ref.current = node;
                    menuButtonRef.current = node;
                  }}
                  label={`更多操作 ${project.title}`}
                  icon={<MoreHorizontal size={17} />}
                />
              </Tooltip>
            )}
          >
            <MenuItem
              disabled={exporting}
              aria-label={strings.exportProject(project.title)}
              icon={<Download size={15} />}
              onSelect={() => onExport(project)}
            >
              {exporting ? "正在导出" : "导出项目"}
            </MenuItem>
            <MenuItem
              danger
              aria-label={strings.deleteProject(project.title)}
              icon={<Trash2 size={15} />}
              onSelect={() => {
                if (menuButtonRef.current) onDelete(project, menuButtonRef.current);
              }}
            >
              删除项目
            </MenuItem>
          </Menu>
        </div>
        <div className={styles.footer}>
          <time dateTime={project.updatedAt}>{new Date(project.updatedAt).toLocaleDateString("zh-CN")}</time>
          <Link className={styles.openAction} to={projectRoutes.storyboard(project.id)} aria-label={openLabel}>
            继续创作 <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </div>
      </div>
    </li>
  );
}
