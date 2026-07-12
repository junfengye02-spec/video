import { CreditCard, ReceiptText } from "lucide-react";
import type { MouseEvent } from "react";
import { Link } from "react-router-dom";
import { projectRoutes } from "../../app/routes";
import { useBilling } from "../../billing/BillingProvider";

interface BillingShellActionProps {
  onBeforeNavigate?: () => boolean;
}

const walletText = "\u94b1\u5305";
const ordersText = "\u8ba2\u5355";

function walletLabel(value: number | null | undefined, loading: boolean): string {
  if (loading || value === null || value === undefined) return walletText;
  return `${walletText} ${value.toLocaleString("zh-CN")}`;
}

export function BillingShellAction({ onBeforeNavigate }: BillingShellActionProps) {
  const billing = useBilling();
  const handleNavigate = (event: MouseEvent<HTMLAnchorElement>) => {
    if (onBeforeNavigate && !onBeforeNavigate()) {
      event.preventDefault();
    }
  };

  return (
    <>
      <Link to={projectRoutes.wallet} onClick={handleNavigate}>
        <CreditCard aria-hidden="true" size={16} />
        {walletLabel(billing.wallet?.available_units, billing.loading)}
      </Link>
      <Link to={projectRoutes.orders} onClick={handleNavigate}>
        <ReceiptText aria-hidden="true" size={16} />
        {ordersText}
      </Link>
    </>
  );
}
