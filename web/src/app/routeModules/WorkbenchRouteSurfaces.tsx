import { getStrings } from "../../i18n";
import { useWorkbench } from "../workbench/useWorkbench";

const zh = getStrings("zh");

export function WorkbenchErrorSurface() {
  const { clearError, error } = useWorkbench();
  if (!error) return null;

  return (
    <div className="workbench-error" role="alert">
      <span>{error}</span>
      <button type="button" aria-label="关闭错误提示" onClick={clearError}>
        关闭
      </button>
    </div>
  );
}

export function LocalBackupStatusSurface() {
  const { localBackupStatus } = useWorkbench();
  if (localBackupStatus === "idle") return null;

  return (
    <p className="workbench-local-backup-status" role="status">
      {zh.localBackup[localBackupStatus]}
    </p>
  );
}
