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
import {
  AuthRequestError,
  authRequest,
  setCsrfToken,
  subscribeToAuthUnauthorized,
} from "./api";
import type {
  AuthResponse,
  AuthUser,
  CsrfResponse,
  LoginInput,
  MeResponse,
  RegisterInput,
  ResetPasswordInput,
} from "./types";

export interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  sendVerification: (email: string) => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  resetPassword: (input: ResetPasswordInput) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(false);
  const generationRef = useRef(0);
  const csrfRef = useRef<string | null>(null);
  const csrfPromiseRef = useRef<Promise<void> | null>(null);

  const rememberCsrf = useCallback((token: string | null) => {
    csrfRef.current = token;
    setCsrfToken(token);
  }, []);

  const acquireCsrf = useCallback(async (force = false) => {
    if (!force && csrfRef.current) return;
    if (csrfPromiseRef.current) return csrfPromiseRef.current;

    const request = authRequest<CsrfResponse>(
      "/api/auth/csrf",
      undefined,
      { notifyUnauthorized: false },
    ).then((response) => {
      if (mountedRef.current) rememberCsrf(response.csrf_token);
    }).finally(() => {
      if (csrfPromiseRef.current === request) csrfPromiseRef.current = null;
    });
    csrfPromiseRef.current = request;
    return request;
  }, [rememberCsrf]);

  const recoverAnonymousSession = useCallback(() => {
    const generation = ++generationRef.current;
    rememberCsrf(null);
    setUser(null);
    setLoading(true);
    void acquireCsrf(true)
      .catch(() => undefined)
      .finally(() => {
        if (mountedRef.current && generation === generationRef.current) setLoading(false);
      });
  }, [acquireCsrf, rememberCsrf]);

  useEffect(() => {
    mountedRef.current = true;
    const generation = ++generationRef.current;
    const unsubscribe = subscribeToAuthUnauthorized(recoverAnonymousSession);

    void (async () => {
      let currentUser: AuthUser | null = null;
      let responseToken: string | null = null;
      try {
        const response = await authRequest<MeResponse>(
          "/api/auth/me",
          undefined,
          { notifyUnauthorized: false },
        );
        currentUser = response.user;
        responseToken = response.csrf_token ?? null;
      } catch (error) {
        if (!(error instanceof AuthRequestError) || error.status !== 401) {
          currentUser = null;
        }
      }

      if (!mountedRef.current || generation !== generationRef.current) return;
      setUser(currentUser);
      if (responseToken) rememberCsrf(responseToken);
      try {
        await acquireCsrf();
      } catch {
        // Public forms remain available and surface a generic request error on submission.
      }
      if (mountedRef.current && generation === generationRef.current) setLoading(false);
    })();

    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      unsubscribe();
      rememberCsrf(null);
    };
  }, [acquireCsrf, recoverAnonymousSession, rememberCsrf]);

  const applyAuthenticatedResponse = useCallback((response: AuthResponse, generation: number) => {
    if (!mountedRef.current || generation !== generationRef.current) return;
    rememberCsrf(response.csrf_token);
    setUser(response.user);
  }, [rememberCsrf]);

  const login = useCallback(async (input: LoginInput) => {
    const generation = ++generationRef.current;
    const response = await authRequest<AuthResponse>(
      "/api/auth/login",
      { method: "POST", body: JSON.stringify(input) },
      { notifyUnauthorized: false },
    );
    applyAuthenticatedResponse(response, generation);
  }, [applyAuthenticatedResponse]);

  const register = useCallback(async (input: RegisterInput) => {
    const generation = ++generationRef.current;
    const response = await authRequest<AuthResponse>(
      "/api/auth/register",
      { method: "POST", body: JSON.stringify(input) },
      { notifyUnauthorized: false },
    );
    applyAuthenticatedResponse(response, generation);
  }, [applyAuthenticatedResponse]);

  const logout = useCallback(async () => {
    const generation = ++generationRef.current;
    await authRequest("/api/auth/logout", { method: "POST" }, { notifyUnauthorized: false });
    if (!mountedRef.current || generation !== generationRef.current) return;

    setUser(null);
    setLoading(true);
    rememberCsrf(null);
    try {
      await acquireCsrf(true);
    } finally {
      if (mountedRef.current && generation === generationRef.current) setLoading(false);
    }
  }, [acquireCsrf, rememberCsrf]);

  const sendVerification = useCallback(async (email: string) => {
    await authRequest(
      "/api/auth/email-verifications",
      { method: "POST", body: JSON.stringify({ email }) },
      { notifyUnauthorized: false },
    );
  }, []);

  const requestPasswordReset = useCallback(async (email: string) => {
    await authRequest(
      "/api/auth/password-reset/request",
      { method: "POST", body: JSON.stringify({ email }) },
      { notifyUnauthorized: false },
    );
  }, []);

  const resetPassword = useCallback(async (input: ResetPasswordInput) => {
    const generation = ++generationRef.current;
    await authRequest(
      "/api/auth/password-reset/confirm",
      { method: "POST", body: JSON.stringify(input) },
      { notifyUnauthorized: false },
    );
    if (mountedRef.current && generation === generationRef.current) {
      setUser(null);
      setLoading(true);
      rememberCsrf(null);
    }
    try {
      await acquireCsrf(true);
    } finally {
      if (mountedRef.current && generation === generationRef.current) setLoading(false);
    }
  }, [acquireCsrf, rememberCsrf]);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    loading,
    login,
    register,
    logout,
    sendVerification,
    requestPasswordReset,
    resetPassword,
  }), [
    loading,
    login,
    logout,
    register,
    requestPasswordReset,
    resetPassword,
    sendVerification,
    user,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within AuthProvider");
  return value;
}
