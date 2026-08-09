import { BlueprintReview } from "../features/blueprint/BlueprintReview";
import type { BlueprintReviewOptions } from "../features/blueprint/useBlueprintReview";

export type PlanReviewPageProps = BlueprintReviewOptions;

export function PlanReviewPage(props: PlanReviewPageProps) {
  return <BlueprintReview {...props} />;
}
