import type { ConsistencyReport } from "./types";

export function scoreTone(report: ConsistencyReport | null): "idle" | "good" | "warning" | "error" {
  if (!report) {
    return "idle";
  }
  if (report.score >= 90) {
    return "good";
  }
  if (report.score >= 70) {
    return "warning";
  }
  return "error";
}
