import type { ResourceLibraryControllerProps } from "../features/resources/model/resourceLibraryTypes";
import { ResourceLibraryScreen } from "../features/resources/ResourceLibraryScreen";

export type ResourceLibraryPageProps = ResourceLibraryControllerProps;

export function ResourceLibraryPage(props: ResourceLibraryPageProps) {
  return <ResourceLibraryScreen {...props} />;
}
