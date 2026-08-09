import { Check, Clock3, FileText } from "lucide-react";
import type { BlueprintDocument as BlueprintDocumentModel, BlueprintField } from "../../../components/blueprint/blueprintModel";
import type { PlanSectionApproval } from "../../../domain/types";
import styles from "../BlueprintDocument.module.css";

const missingText = "当前规划未单独记录";

function formatTimestamp(value: string | null): string {
  if (!value) return "时间未记录";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function BlueprintFieldValue({ field }: { field: BlueprintField }) {
  if (Array.isArray(field.value)) {
    return field.value.length ? (
      <ul>{field.value.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
    ) : <p className={styles.fieldEmpty}>{missingText}</p>;
  }
  return <p className={!field.value ? styles.fieldEmpty : undefined}>{field.value || missingText}</p>;
}

export function BlueprintDocument({
  approval,
  document,
}: {
  approval: PlanSectionApproval;
  document: BlueprintDocumentModel;
}) {
  return (
    <article className={styles.canvas} aria-labelledby={`blueprint-document-${document.id}`}>
      <header className={styles.heading}>
        <div className={styles.meta}>
          <span><FileText aria-hidden="true" size={13} /> MISE BLUEPRINT</span>
        </div>
        <h1 id={`blueprint-document-${document.id}`}>{document.title}</h1>
        <p>{document.description}</p>
        <div className={styles.state} data-testid="blueprint-document-state" data-status={approval.status}>
          {approval.status === "approved" ? <Check aria-hidden="true" size={14} /> : <Clock3 aria-hidden="true" size={14} />}
          <span>
            <strong>{approval.status === "approved" ? "已确认" : approval.status === "changes_requested" ? "已要求修改" : "等待确认"}</strong>
            {approval.status === "approved" ? ` · ${formatTimestamp(approval.updated_at)}` : ""}
          </span>
        </div>
      </header>

      <div className={styles.content}>
        {document.entries.length ? document.entries.map((entry, entryIndex) => (
          <section className={styles.entry} key={entry.id}>
            <div className={styles.entryIndex}>{String(entryIndex + 1).padStart(2, "0")}</div>
            <div className={styles.entryBody}>
              <header>
                <h2>{entry.title}</h2>
                {entry.subtitle ? <p>{entry.subtitle}</p> : null}
              </header>
              <dl className={styles.fieldList}>
                {entry.fields.map((field) => (
                  <div key={field.label} className={field.prompt ? styles.promptField : undefined}>
                    <dt>{field.label}</dt>
                    <dd><BlueprintFieldValue field={field} /></dd>
                  </div>
                ))}
              </dl>
            </div>
          </section>
        )) : (
          <div className={styles.emptyDocument}>
            <FileText aria-hidden="true" size={20} />
            <strong>此分类暂无规划内容</strong>
            <p>当前服务端 artifact 没有可展示的条目，请要求修改后再确认。</p>
          </div>
        )}
      </div>
    </article>
  );
}
