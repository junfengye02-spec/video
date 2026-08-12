import { authRequest } from "../../auth/api";

export type VideoModelCatalogStatus = "available" | "missing_from_catalog";
export type VideoModelConfigurationStatus = "configured" | "unconfigured";

export interface AdminVideoModelDurationItem {
  provider: string;
  model_id: string;
  catalog_status: VideoModelCatalogStatus;
  configuration_status: VideoModelConfigurationStatus;
  call_duration_seconds: number | null;
  version: number | null;
  profile_revision: string | null;
  updated_by: string | null;
  updated_at: string | null;
}

export type AdminVideoModelDurationSetting = Omit<
  AdminVideoModelDurationItem,
  "catalog_status"
>;

export interface AdminVideoModelCatalog {
  provider: "newapi";
  catalog_refresh_status: "ok" | "failed";
  catalog_error_code: string | null;
  models: AdminVideoModelDurationItem[];
}

export interface UpdateAdminVideoModelDurationRequest {
  call_duration_seconds: number;
  expected_version: number;
  reason: string;
}

export interface DeleteAdminVideoModelDurationRequest {
  expected_version: number;
  reason: string;
}

type ObjectRecord = Record<string, unknown>;

function asObject(value: unknown): ObjectRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid video model administration response");
  }
  return value as ObjectRecord;
}

function requiredString(record: ObjectRecord, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid ${field} in video model administration response`);
  }
  return value;
}

function nullableString(record: ObjectRecord, field: string): string | null {
  const value = record[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(`Invalid ${field} in video model administration response`);
  }
  return value;
}

function nullablePositiveNumber(record: ObjectRecord, field: string): number | null {
  const value = record[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${field} in video model administration response`);
  }
  return value;
}

function nullableVersion(record: ObjectRecord): number | null {
  const value = record.version;
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error("Invalid version in video model administration response");
  }
  return value as number;
}

function videoModelSetting(value: unknown): AdminVideoModelDurationSetting {
  const record = asObject(value);
  const configurationStatus = requiredString(record, "configuration_status");
  if (configurationStatus !== "configured" && configurationStatus !== "unconfigured") {
    throw new Error("Invalid configuration_status in video model administration response");
  }
  const item: AdminVideoModelDurationSetting = {
    provider: requiredString(record, "provider"),
    model_id: requiredString(record, "model_id"),
    configuration_status: configurationStatus,
    call_duration_seconds: nullablePositiveNumber(record, "call_duration_seconds"),
    version: nullableVersion(record),
    profile_revision: nullableString(record, "profile_revision"),
    updated_by: nullableString(record, "updated_by"),
    updated_at: nullableString(record, "updated_at"),
  };
  if (
    (item.configuration_status === "configured"
      && (item.call_duration_seconds === null || item.version === null || item.profile_revision === null))
    || (item.configuration_status === "unconfigured"
      && (item.call_duration_seconds !== null || item.version !== null || item.profile_revision !== null))
  ) {
    throw new Error("Inconsistent video model configuration response");
  }
  return item;
}

function adminVideoModel(value: unknown): AdminVideoModelDurationItem {
  const record = asObject(value);
  const catalogStatus = requiredString(record, "catalog_status");
  if (catalogStatus !== "available" && catalogStatus !== "missing_from_catalog") {
    throw new Error("Invalid catalog_status in video model administration response");
  }
  return { ...videoModelSetting(record), catalog_status: catalogStatus };
}

function adminVideoModelCatalog(value: unknown): AdminVideoModelCatalog {
  const record = asObject(value);
  const provider = requiredString(record, "provider");
  const refreshStatus = requiredString(record, "catalog_refresh_status");
  if (provider !== "newapi" || (refreshStatus !== "ok" && refreshStatus !== "failed")) {
    throw new Error("Invalid video model catalog response");
  }
  if (!Array.isArray(record.models)) {
    throw new Error("Invalid models in video model catalog response");
  }
  return {
    provider,
    catalog_refresh_status: refreshStatus,
    catalog_error_code: nullableString(record, "catalog_error_code"),
    models: record.models.map(adminVideoModel),
  };
}

export async function listAdminVideoModels(): Promise<AdminVideoModelCatalog> {
  return adminVideoModelCatalog(
    await authRequest("/api/admin/video-model-duration-settings"),
  );
}

export async function updateAdminVideoModelDuration(
  modelId: string,
  payload: UpdateAdminVideoModelDurationRequest,
): Promise<AdminVideoModelDurationSetting> {
  return videoModelSetting(await authRequest(
    `/api/admin/video-model-duration-settings/${encodeURIComponent(modelId)}`,
    { method: "PUT", body: JSON.stringify(payload) },
  ));
}

export async function deleteAdminVideoModelDuration(
  modelId: string,
  payload: DeleteAdminVideoModelDurationRequest,
): Promise<void> {
  await authRequest(
    `/api/admin/video-model-duration-settings/${encodeURIComponent(modelId)}`,
    { method: "DELETE", body: JSON.stringify(payload) },
  );
}
