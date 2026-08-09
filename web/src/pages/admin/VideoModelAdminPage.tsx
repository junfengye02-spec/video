import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  RefreshCw,
  Save,
  Search,
  Video,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AuthRequestError } from "../../auth/api";
import {
  listAdminVideoModels,
  updateAdminVideoModelDuration,
  type AdminVideoModelCatalog,
  type AdminVideoModelDurationItem,
} from "../../features/admin/videoModels";
import { detectLocale, getStrings } from "../../i18n";
import { Button, Dialog } from "../../shared/ui";
import styles from "./VideoModelAdminPage.module.css";

interface PendingChange {
  item: AdminVideoModelDurationItem;
  duration: number;
  reason: string;
}

function durationFromText(value: string): number | null {
  if (!value.trim()) return null;
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function durationText(value: number): string {
  return String(value);
}

export function VideoModelAdminPage() {
  const locale = detectLocale(typeof navigator === "undefined" ? null : navigator.language);
  const copy = getStrings(locale).adminVideoModels;
  const [catalog, setCatalog] = useState<AdminVideoModelCatalog | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [savingModelId, setSavingModelId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<PendingChange | null>(null);
  const [confirmationError, setConfirmationError] = useState<string | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);

  const loadCatalog = useCallback(async (mode: "initial" | "refresh" = "refresh") => {
    if (mode === "initial") setLoading(true);
    else setRefreshing(true);
    setError(null);
    setNotice(null);
    try {
      const response = await listAdminVideoModels();
      setCatalog(response);
      setDrafts(Object.fromEntries(response.models.map((item) => [
        item.model_id,
        item.call_duration_seconds === null ? "" : durationText(item.call_duration_seconds),
      ])));
      return response;
    } catch (caught) {
      if (caught instanceof AuthRequestError && caught.code === "forbidden") {
        setError(copy.forbidden);
      } else {
        setError(copy.loadError);
      }
      return null;
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [copy.forbidden, copy.loadError]);

  useEffect(() => {
    void loadCatalog("initial");
  }, [loadCatalog]);

  const visibleModels = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return catalog?.models ?? [];
    return (catalog?.models ?? []).filter((item) => (
      item.model_id.toLocaleLowerCase().includes(normalized)
    ));
  }, [catalog, query]);

  function requestSave(item: AdminVideoModelDurationItem, opener: HTMLButtonElement) {
    const duration = durationFromText(drafts[item.model_id] ?? "");
    if (duration === null) {
      setError(copy.invalidDuration);
      return;
    }
    openerRef.current = opener;
    setError(null);
    setNotice(null);
    setConfirmationError(null);
    setConfirmation({ item, duration, reason: "" });
  }

  async function confirmSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmation || savingModelId || !confirmation.reason.trim()) return;
    const pending = confirmation;
    setSavingModelId(pending.item.model_id);
    setConfirmationError(null);
    try {
      const saved = await updateAdminVideoModelDuration(pending.item.model_id, {
        call_duration_seconds: pending.duration,
        expected_version: pending.item.version ?? 0,
        reason: pending.reason.trim(),
      });
      setCatalog((current) => current ? {
        ...current,
        models: current.models.map((item) => item.model_id === saved.model_id
          ? { ...item, ...saved }
          : item),
      } : current);
      setDrafts((current) => ({
        ...current,
        [saved.model_id]: durationText(saved.call_duration_seconds ?? pending.duration),
      }));
      setConfirmation(null);
      setNotice(copy.success(saved.model_id, saved.version ?? (pending.item.version ?? 0) + 1));
    } catch (caught) {
      if (caught instanceof AuthRequestError && caught.code === "conflict") {
        setConfirmation(null);
        await loadCatalog("refresh");
        setError(copy.conflict);
      } else if (caught instanceof AuthRequestError && caught.code === "csrf_invalid") {
        setConfirmationError(copy.csrfError);
      } else if (caught instanceof AuthRequestError && caught.code === "forbidden") {
        setConfirmationError(copy.forbidden);
      } else {
        setConfirmationError(copy.saveError);
      }
    } finally {
      setSavingModelId(null);
    }
  }

  return (
    <section className={`billing-admin-page billing-workspace ${styles.root}`} aria-labelledby="video-model-admin-title">
      <div className="page-heading billing-page-heading">
        <div>
          <span className="page-eyebrow">{copy.eyebrow}</span>
          <h1 id="video-model-admin-title">{copy.title}</h1>
          <p>{copy.description}</p>
        </div>
        <Button
          variant="secondary"
          icon={<RefreshCw size={16} />}
          loading={refreshing}
          disabled={loading || savingModelId !== null}
          onClick={() => void loadCatalog("refresh")}
        >
          {refreshing ? copy.refreshingAction : copy.refreshAction}
        </Button>
      </div>

      {error ? <p className="billing-notice is-error" role="alert">{error}</p> : null}
      {notice ? (
        <p className="billing-notice is-success" role="status">
          <CheckCircle2 aria-hidden="true" size={15} /> {notice}
        </p>
      ) : null}
      {catalog?.catalog_refresh_status === "failed" ? (
        <p className={styles.catalogWarning} role="status">
          <AlertTriangle aria-hidden="true" size={16} />
          <span>{copy.catalogUnavailable}</span>
          {catalog.catalog_error_code ? <code>{catalog.catalog_error_code}</code> : null}
        </p>
      ) : null}

      {loading && !catalog ? (
        <p className="billing-loading" role="status">{copy.loading}</p>
      ) : catalog ? (
        <>
          <div className={styles.toolbar}>
            <label htmlFor="video-model-search">{copy.searchLabel}</label>
            <div className={styles.searchField}>
              <Search aria-hidden="true" size={16} />
              <input
                id="video-model-search"
                type="search"
                value={query}
                placeholder={copy.searchPlaceholder}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <span role="status" aria-live="polite">
              {copy.resultCount(visibleModels.length, catalog.models.length)}
            </span>
          </div>

          {catalog.models.length === 0 ? (
            <p className="billing-empty">{copy.empty}</p>
          ) : visibleModels.length === 0 ? (
            <p className="billing-empty">{copy.noMatches}</p>
          ) : (
            <ul className={styles.modelList} aria-label={copy.modelListLabel}>
              {visibleModels.map((item) => {
                const draft = drafts[item.model_id] ?? "";
                const duration = durationFromText(draft);
                const invalid = duration === null;
                const unchanged = duration !== null && duration === item.call_duration_seconds;
                const saving = savingModelId === item.model_id;
                const validationId = `duration-error-${item.model_id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
                return (
                  <li key={item.model_id}>
                    <header className={styles.modelHeader}>
                      <span className={styles.modelIcon}><Video aria-hidden="true" size={17} /></span>
                      <code>{item.model_id}</code>
                      <span className={styles.badges}>
                        <span data-tone={item.configuration_status === "configured" ? "success" : "warning"}>
                          {item.configuration_status === "configured"
                            ? copy.configuredStatus
                            : copy.unconfiguredStatus}
                        </span>
                        <span data-tone={item.catalog_status === "available" ? "neutral" : "danger"}>
                          {item.catalog_status === "available"
                            ? copy.catalogAvailableStatus
                            : copy.catalogMissingStatus}
                        </span>
                      </span>
                    </header>

                    <dl className={styles.modelFacts}>
                      <div>
                        <dt>{copy.currentDurationLabel}</dt>
                        <dd>{item.call_duration_seconds === null
                          ? copy.durationUnconfigured
                          : copy.durationValue(item.call_duration_seconds)}</dd>
                      </div>
                      <div>
                        <dt>{copy.versionLabel}</dt>
                        <dd>{item.version === null ? copy.newVersion : copy.versionValue(item.version)}</dd>
                      </div>
                      <div>
                        <dt>{copy.revisionLabel}</dt>
                        <dd><code>{item.profile_revision ?? copy.revisionUnavailable}</code></dd>
                      </div>
                      <div>
                        <dt>{copy.updatedLabel}</dt>
                        <dd>{formatUpdatedAt(item.updated_at, locale, copy.neverUpdated)}</dd>
                      </div>
                    </dl>

                    <div className={styles.editor}>
                      <label htmlFor={`duration-${validationId}`}>
                        {copy.durationInputLabel(item.model_id)}
                        <span className={styles.durationInput}>
                          <Clock3 aria-hidden="true" size={15} />
                          <input
                            id={`duration-${validationId}`}
                            type="number"
                            min="0"
                            step="any"
                            inputMode="decimal"
                            value={draft}
                            disabled={saving}
                            aria-label={copy.durationInputLabel(item.model_id)}
                            aria-invalid={invalid}
                            aria-describedby={invalid ? validationId : undefined}
                            onChange={(event) => setDrafts((current) => ({
                              ...current,
                              [item.model_id]: event.target.value,
                            }))}
                          />
                          <span aria-hidden="true">s</span>
                        </span>
                      </label>
                      {invalid ? <small id={validationId} className={styles.validation}>{copy.invalidDuration}</small> : null}
                      <Button
                        variant="primary"
                        icon={<Save size={15} />}
                        loading={saving}
                        disabled={invalid || unchanged || savingModelId !== null}
                        onClick={(event) => requestSave(item, event.currentTarget)}
                      >
                        {saving ? copy.savingAction : copy.saveAction}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : (
        <div className={styles.loadFailure}>
          <p>{copy.loadError}</p>
          <Button variant="secondary" icon={<RefreshCw size={15} />} onClick={() => void loadCatalog("initial")}>
            {copy.retryAction}
          </Button>
        </div>
      )}

      <Dialog
        open={confirmation !== null}
        closeDisabled={savingModelId !== null}
        openerRef={openerRef}
        title={confirmation ? copy.confirmTitle(confirmation.item.model_id) : ""}
        onClose={() => {
          if (!savingModelId) setConfirmation(null);
        }}
      >
        {confirmation ? (
          <form className={styles.confirmation} onSubmit={(event) => void confirmSave(event)}>
            <p>{copy.confirmDescription(
              confirmation.item.call_duration_seconds === null
                ? copy.durationUnconfigured
                : copy.durationValue(confirmation.item.call_duration_seconds),
              copy.durationValue(confirmation.duration),
            )}</p>
            <label htmlFor="video-model-change-reason">
              {copy.reasonLabel}
              <textarea
                id="video-model-change-reason"
                autoFocus
                maxLength={500}
                rows={4}
                value={confirmation.reason}
                disabled={savingModelId !== null}
                placeholder={copy.reasonPlaceholder}
                onChange={(event) => setConfirmation((current) => current
                  ? { ...current, reason: event.target.value }
                  : current)}
              />
            </label>
            <p className={styles.auditNotice}>{copy.auditNotice}</p>
            {confirmationError ? <p className={styles.dialogError} role="alert">{confirmationError}</p> : null}
            <footer>
              <Button variant="secondary" disabled={savingModelId !== null} onClick={() => setConfirmation(null)}>
                {copy.cancelAction}
              </Button>
              <Button
                type="submit"
                variant="primary"
                icon={<Save size={15} />}
                loading={savingModelId !== null}
                disabled={!confirmation.reason.trim()}
              >
                {savingModelId ? copy.savingAction : copy.confirmAction}
              </Button>
            </footer>
          </form>
        ) : null}
      </Dialog>
    </section>
  );
}

function formatUpdatedAt(value: string | null, locale: "en" | "zh", fallback: string): string {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
