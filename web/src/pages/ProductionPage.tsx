import { ProductionScreen } from "../features/production/ProductionScreen";
import type { ProductionControllerProps } from "../features/production/model/useProductionController";

export type ProductionPageProps = ProductionControllerProps;

export function ProductionPage(props: ProductionPageProps) {
  return <ProductionScreen {...props} />;
}
