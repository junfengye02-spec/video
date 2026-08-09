import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "../auth/AuthProvider";
import { getWallet } from "./api";
import type { WalletSummary } from "./types";

export interface BillingContextValue {
  wallet: WalletSummary | null;
  loading: boolean;
  error: string | null;
  refreshWallet: () => Promise<WalletSummary | null>;
}

const BillingContext = createContext<BillingContextValue | null>(null);
const BILLING_INVALIDATED_EVENT = "mise:billing-invalidated";
const BILLING_CHANNEL = "mise-billing";
const BILLING_TAB_ID = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
  ? crypto.randomUUID()
  : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

export function notifyBillingChanged(): void {
  window.dispatchEvent(new Event(BILLING_INVALIDATED_EVENT));
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(BILLING_CHANNEL);
  channel.postMessage({ sourceId: BILLING_TAB_ID, type: "invalidate" });
  channel.close();
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Unable to load wallet.";
}

export function BillingProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const userId = auth.user?.id ?? null;
  const [wallet, setWallet] = useState<WalletSummary | null>(null);
  const [loading, setLoading] = useState(auth.loading);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(false);
  const refreshPromiseRef = useRef<Promise<WalletSummary | null> | null>(null);

  const refreshWalletForGeneration = useCallback((generation: number) => {
    if (auth.loading || !userId) {
      setWallet(null);
      setLoading(Boolean(auth.loading));
      setError(null);
      return Promise.resolve(null);
    }
    if (refreshPromiseRef.current) return refreshPromiseRef.current;

    setLoading(true);
    setError(null);
    const request = getWallet()
      .then((nextWallet) => {
        if (mountedRef.current && generation === generationRef.current) {
          setWallet(nextWallet);
        }
        return nextWallet;
      })
      .catch((loadError: unknown) => {
        if (mountedRef.current && generation === generationRef.current) {
          setWallet(null);
          setError(errorMessage(loadError));
        }
        return null;
      })
      .finally(() => {
        if (refreshPromiseRef.current === request) {
          refreshPromiseRef.current = null;
        }
        if (mountedRef.current && generation === generationRef.current) {
          setLoading(false);
        }
      });
    refreshPromiseRef.current = request;
    return request;
  }, [auth.loading, userId]);

  const refreshWallet = useCallback(
    () => refreshWalletForGeneration(generationRef.current),
    [refreshWalletForGeneration],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      refreshPromiseRef.current = null;
    };
  }, []);

  useEffect(() => {
    const generation = ++generationRef.current;
    refreshPromiseRef.current = null;

    if (auth.loading) {
      setLoading(true);
      return;
    }
    if (!userId) {
      setWallet(null);
      setLoading(false);
      setError(null);
      return;
    }
    void refreshWalletForGeneration(generation);
  }, [auth.loading, refreshWalletForGeneration, userId]);

  useEffect(() => {
    if (!userId) return undefined;
    const handleInvalidation = () => {
      void refreshWallet();
    };
    window.addEventListener(BILLING_INVALIDATED_EVENT, handleInvalidation);
    const channel = typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel(BILLING_CHANNEL);
    if (channel) {
      channel.onmessage = (event: MessageEvent<unknown>) => {
        const message = event.data;
        if (
          message
          && typeof message === "object"
          && "sourceId" in message
          && (message as { sourceId?: unknown }).sourceId === BILLING_TAB_ID
        ) return;
        handleInvalidation();
      };
    }
    return () => {
      window.removeEventListener(BILLING_INVALIDATED_EVENT, handleInvalidation);
      channel?.close();
    };
  }, [refreshWallet, userId]);

  const value = useMemo<BillingContextValue>(() => ({
    wallet,
    loading,
    error,
    refreshWallet,
  }), [error, loading, refreshWallet, wallet]);

  return <BillingContext.Provider value={value}>{children}</BillingContext.Provider>;
}

export function useBilling(): BillingContextValue {
  const value = useContext(BillingContext);
  if (!value) throw new Error("useBilling must be used within BillingProvider");
  return value;
}
