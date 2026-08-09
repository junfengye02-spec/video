import { ContinuityScreen } from "../features/continuity/ContinuityScreen";
import type { ContinuityControllerProps } from "../features/continuity/model/useContinuityController";

export type GlobalSettingsPageProps = ContinuityControllerProps;

export function GlobalSettingsPage(props: GlobalSettingsPageProps) {
  return <ContinuityScreen {...props} />;
}
