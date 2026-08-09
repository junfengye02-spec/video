import { CreditCard } from "lucide-react";
import type { MouseEvent } from "react";
import { Link } from "react-router-dom";
import { projectRoutes } from "../../app/routes";
import { useBilling } from "../../billing/BillingProvider";
import { formatCnyUnits } from "../../billing/money";

interface BillingShellActionProps {
  onBeforeNavigate?: () => boolean;
}

const walletText = "\u94b1\u5305";

function walletLabel(value: number | null | undefined, loading: boolean): string {
  if (loading || value === null || value === undefined) return walletText;
  return `${walletText} ${formatCnyUnits(value)}`;
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
    </>
  );
}
