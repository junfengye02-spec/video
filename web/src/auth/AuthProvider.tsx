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
  const csrfVersionRef = useRef(0);
  const csrfPromiseRef = useRef<{ promise: Promise<void>; version: number } | null>(null);

  const rememberCsrf = useCallback((token: string | null) => {
    csrfRef.current = token;
    setCsrfToken(token);
  }, []);

  const invalidateCsrf = useCallback(() => {
    csrfVersionRef.current += 1;
    rememberCsrf(null);
  }, [rememberCsrf]);

  const adoptCsrf = useCallback((token: string) => {
    csrfVersionRef.current += 1;
    rememberCsrf(token);
  }, [rememberCsrf]);

  const acquireCsrf = useCallback(async (force = false) => {
    if (!force && csrfRef.current) return;

    while (true) {
      const version = csrfVersionRef.current;
      const pending = csrfPromiseRef.current;
      if (pending) {
        if (pending.version === version) return pending.promise;
        try {
          await pending.promise;
        } catch {
          // A superseded request cannot satisfy the current session generation.
        }
        continue;
      }

      const request = authRequest<CsrfResponse>(
        "/api/auth/csrf",
        undefined,
        { notifyUnauthorized: false },
      ).then((response) => {
        if (mountedRef.current && version === csrfVersionRef.current) {
          rememberCsrf(response.csrf_token);
        }
      });
      let trackedRequest: Promise<void>;
      trackedRequest = request.finally(() => {
        if (csrfPromiseRef.current?.promise === trackedRequest) csrfPromiseRef.current = null;
      });
      csrfPromiseRef.current = { promise: trackedRequest, version };
      return trackedRequest;
    }
  }, [rememberCsrf]);

  const recoverAnonymousSession = useCallback(() => {
    const generation = ++generationRef.current;
    invalidateCsrf();
    setUser(null);
    setLoading(true);
    void acquireCsrf(true)
      .catch(() => undefined)
      .finally(() => {
        if (mountedRef.current && generation === generationRef.current) setLoading(false);
      });
  }, [acquireCsrf, invalidateCsrf]);

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
      if (responseToken) adoptCsrf(responseToken);
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
      invalidateCsrf();
    };
  }, [acquireCsrf, adoptCsrf, invalidateCsrf, recoverAnonymousSession]);

  const applyAuthenticatedResponse = useCallback((response: AuthResponse, generation: number) => {
    if (!mountedRef.current || generation !== generationRef.current) return;
    adoptCsrf(response.csrf_token);
    setUser(response.user);
  }, [adoptCsrf]);

  const requestAuthMutation = useCallback(async <ResponseBody,>(
    path: string,
    body?: unknown,
  ): Promise<ResponseBody> => {
    const init = { method: "POST", body: JSON.stringify(body) };
    try {
      return await authRequest<ResponseBody>(path, init, { notifyUnauthorized: false });
    } catch (error) {
      const recoverable = error instanceof AuthRequestError
        && (error.code === "session_invalid" || error.code === "csrf_invalid");
      if (!recoverable) throw error;

      invalidateCsrf();
      await acquireCsrf(true);
      return authRequest<ResponseBody>(path, init, { notifyUnauthorized: false });
    }
  }, [acquireCsrf, invalidateCsrf]);

  const login = useCallback(async (input: LoginInput) => {
    const generation = ++generationRef.current;
    const response = await requestAuthMutation<AuthResponse>(
      "/api/auth/login",
      input,
    );
    applyAuthenticatedResponse(response, generation);
  }, [applyAuthenticatedResponse, requestAuthMutation]);

  const register = useCallback(async (input: RegisterInput) => {
    const generation = ++generationRef.current;
    const response = await requestAuthMutation<AuthResponse>(
      "/api/auth/register",
      input,
    );
    applyAuthenticatedResponse(response, generation);
  }, [applyAuthenticatedResponse, requestAuthMutation]);

  const logout = useCallback(async () => {
    const generation = ++generationRef.current;
    try {
      await requestAuthMutation<void>("/api/auth/logout");
    } catch (error) {
      if (!(error instanceof AuthRequestError) || error.code !== "session_invalid") throw error;
    }
    if (!mountedRef.current || generation !== generationRef.current) return;

    setUser(null);
    setLoading(true);
    invalidateCsrf();
    try {
      await acquireCsrf(true);
    } finally {
      if (mountedRef.current && generation === generationRef.current) setLoading(false);
    }
  }, [acquireCsrf, invalidateCsrf, requestAuthMutation]);

  const resetPassword = useCallback(async (input: ResetPasswordInput) => {
    const generation = ++generationRef.current;
    await requestAuthMutation<void>(
      "/api/auth/password-reset/confirm",
      input,
    );
    if (mountedRef.current && generation === generationRef.current) {
      setUser(null);
      setLoading(true);
      invalidateCsrf();
    }
    try {
      await acquireCsrf(true);
    } finally {
      if (mountedRef.current && generation === generationRef.current) setLoading(false);
    }
  }, [acquireCsrf, invalidateCsrf, requestAuthMutation]);

  const sendVerification = useCallback(
    (email: string) => requestAuthMutation<void>(
      "/api/auth/email-verifications",
      { email },
    ),
    [requestAuthMutation],
  );

  const requestPasswordReset = useCallback(
    (email: string) => requestAuthMutation<void>(
      "/api/auth/password-reset/request",
      { email },
    ),
    [requestAuthMutation],
  );

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
