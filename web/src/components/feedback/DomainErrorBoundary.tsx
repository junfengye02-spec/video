import { Component, type ErrorInfo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { projectRoutes } from "../../app/routes";
import { formatCnyUnits } from "../../billing/money";

const defaultTitle = "\u5f53\u524d\u533a\u57df\u9047\u5230\u9519\u8bef";
const defaultMessage = "\u6b64\u533a\u57df\u6682\u65f6\u65e0\u6cd5\u663e\u793a\uff0c\u5176\u4ed6\u9875\u9762\u4ecd\u53ef\u4f7f\u7528\u3002";
const defaultRetryLabel = "\u91cd\u8bd5";
const paymentTitle = "\u4f59\u989d\u4e0d\u8db3";
const availableBalanceLabel = "\u53ef\u7528\u4f59\u989d";
const requiredBalanceLabel = "\u672c\u6b21\u6700\u591a\u9700\u8981";
const unknownBalanceText = "\u672a\u77e5";
const paymentRequiredUnknownText = "\u672c\u6b21\u9700\u8981\u66f4\u591a\u4f59\u989d";
const walletLinkText = "\u524d\u5f80\u94b1\u5305";

export interface DomainErrorBoundaryProps {
  children: ReactNode;
  message?: ReactNode;
  onCaught?: (error: Error, info: ErrorInfo) => void;
  onRetry?: () => void;
  resetKeys?: readonly unknown[];
  retryLabel?: string;
  title?: ReactNode;
}

interface DomainErrorBoundaryState {
  error: Error | null;
}

export type CommandError =
  | { kind: "message"; message: string }
  | {
    kind: "payment";
    availableUnits: number | null;
    requiredUnits: number | null;
    billingJobId: string | null;
  };

export interface CommandErrorOptions {
  fallback: string;
  onSessionExpired?: () => void;
  walletAvailableUnits?: number | null;
}

function resetKeysChanged(
  previous: readonly unknown[] | undefined,
  next: readonly unknown[] | undefined,
): boolean {
  if (previous === next) return false;
  if (!previous || !next) return Boolean(previous?.length ?? next?.length ?? 0);
  return previous.length !== next.length || previous.some((value, index) => !Object.is(value, next[index]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function errorStatus(error: unknown): number | null {
  if (!isRecord(error) || typeof error.status !== "number") return null;
  return error.status;
}

function errorCode(error: unknown): string | null {
  if (!isRecord(error) || typeof error.code !== "string") return null;
  return error.code;
}

function errorRecords(error: unknown): Record<string, unknown>[] {
  if (!isRecord(error)) return [];
  const records = [error];
  if (isRecord(error.details)) records.push(error.details);
  return records;
}

function numericField(error: unknown, fields: readonly string[]): number | null {
  for (const record of errorRecords(error)) {
    for (const field of fields) {
      const value = record[field];
      if (Number.isFinite(value)) return value as number;
    }
  }
  return null;
}

function billingJobId(error: unknown): string | null {
  for (const record of errorRecords(error)) {
    const value = record.billing_job_id ?? record.billingJobId;
    if (typeof value === "string" && /^[0-9a-f]{32}$/.test(value)) return value;
  }
  return null;
}

function formatUnits(value: number | null): string {
  return value === null ? unknownBalanceText : formatCnyUnits(value);
}

function isPaymentRequired(error: unknown): boolean {
  const status = errorStatus(error);
  const code = errorCode(error);
  return status === 402
    || code === "payment_required"
    || code === "payment_required_quote"
    || code === "insufficient_balance";
}

export function commandErrorFrom(
  error: unknown,
  options: CommandErrorOptions,
): CommandError | null {
  if (errorStatus(error) === 401) {
    options.onSessionExpired?.();
    return null;
  }

  if (isPaymentRequired(error)) {
    return {
      kind: "payment",
      availableUnits: numericField(error, ["availableUnits", "available_units"])
        ?? options.walletAvailableUnits
        ?? null,
      requiredUnits: numericField(error, ["requiredUnits", "required_units", "requiredUnitsMax"]),
      billingJobId: billingJobId(error),
    };
  }

  return {
    kind: "message",
    message: error instanceof Error && error.message ? error.message : options.fallback,
  };
}

export function CommandErrorNotice({
  error,
  walletLinkTarget,
}: {
  error: CommandError | null;
  walletLinkTarget?: "_blank";
}) {
  if (!error) return null;

  if (error.kind === "payment") {
    return (
      <div className="command-error command-error-payment" role="alert">
        <strong>{paymentTitle}</strong>
        <p>{availableBalanceLabel} {formatUnits(error.availableUnits)}</p>
        <p>
          {error.requiredUnits === null
            ? paymentRequiredUnknownText
            : `${requiredBalanceLabel} ${formatUnits(error.requiredUnits)}`}
        </p>
        <Link
          to={projectRoutes.wallet}
          target={walletLinkTarget}
          rel={walletLinkTarget === "_blank" ? "noopener noreferrer" : undefined}
        >
          {walletLinkText}
        </Link>
      </div>
    );
  }

  return <p className="command-error" role="alert">{error.message}</p>;
}

export class DomainErrorBoundary extends Component<
  DomainErrorBoundaryProps,
  DomainErrorBoundaryState
> {
  state: DomainErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): DomainErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onCaught?.(error, info);
  }

  componentDidUpdate(previousProps: DomainErrorBoundaryProps) {
    if (
      this.state.error
      && resetKeysChanged(previousProps.resetKeys, this.props.resetKeys)
    ) {
      this.setState({ error: null });
    }
  }

  private readonly retry = () => {
    this.setState({ error: null });
    this.props.onRetry?.();
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <section className="domain-error-boundary" role="alert">
        <h2>{this.props.title ?? defaultTitle}</h2>
        <p>{this.props.message ?? defaultMessage}</p>
        <button type="button" onClick={this.retry}>
          {this.props.retryLabel ?? defaultRetryLabel}
        </button>
      </section>
    );
  }
}
