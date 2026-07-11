import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import {
  AuthErrors,
  AuthPageFrame,
  safeAuthError,
  validateEmail,
  validatePassword,
} from "../auth/AuthForm";

interface LoginLocationState {
  from?: { pathname: string; search?: string; hash?: string };
}

export function LoginPage() {
  const auth = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState({ email: null as string | null, password: null as string | null });
  const [requestError, setRequestError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const from = (location.state as LoginLocationState | null)?.from;
  const destination = from ? `${from.pathname}${from.search ?? ""}${from.hash ?? ""}` : "/projects";

  if (!auth.loading && auth.user) return <Navigate replace to={destination} />;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const errors = { email: validateEmail(email), password: validatePassword(password) };
    setFieldErrors(errors);
    setRequestError(null);
    if (errors.email || errors.password) return;

    setPending(true);
    try {
      await auth.login({ email: email.trim(), password });
    } catch (error) {
      setRequestError(safeAuthError(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthPageFrame
      title="Sign in"
      footer={(
        <>
          <Link to="/register">Create account</Link>
          <Link to="/forgot-password">Forgot password?</Link>
        </>
      )}
    >
      {auth.loading ? <p className="auth-status" role="status">Checking your session...</p> : (
        <form className="auth-form" noValidate onSubmit={(event) => void handleSubmit(event)}>
          <label>
            Email
            <input
              type="email"
              autoComplete="username"
              maxLength={320}
              disabled={pending}
              aria-invalid={Boolean(fieldErrors.email)}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              minLength={8}
              maxLength={64}
              disabled={pending}
              aria-invalid={Boolean(fieldErrors.password)}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <AuthErrors errors={[fieldErrors.email, fieldErrors.password, requestError]} />
          <button type="submit" disabled={pending}>{pending ? "Signing in..." : "Sign in"}</button>
        </form>
      )}
    </AuthPageFrame>
  );
}
