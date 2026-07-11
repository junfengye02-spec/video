import { useState, type FormEvent } from "react";
import { Link, Navigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import {
  AuthErrors,
  AuthPageFrame,
  safeAuthError,
  validateCode,
  validateEmail,
  validatePassword,
} from "../auth/AuthForm";

export function ResetPasswordPage() {
  const auth = useAuth();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [fieldErrors, setFieldErrors] = useState({
    email: null as string | null,
    code: null as string | null,
    password: null as string | null,
    confirmation: null as string | null,
  });
  const [requestError, setRequestError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!auth.loading && auth.user) return <Navigate replace to="/projects" />;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const errors = {
      email: validateEmail(email),
      code: validateCode(code),
      password: validatePassword(password),
      confirmation: password === confirmation ? null : "Passwords must match.",
    };
    setFieldErrors(errors);
    setRequestError(null);
    setStatus(null);
    if (Object.values(errors).some(Boolean)) return;

    setPending(true);
    try {
      await auth.resetPassword({ email: email.trim(), code, new_password: password });
      setStatus("Password reset complete. You can sign in.");
    } catch (error) {
      setRequestError(safeAuthError(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthPageFrame title="Choose a new password" footer={<Link to="/login">Sign in</Link>}>
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
            Reset code
            <input
              type="text"
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              disabled={pending}
              aria-invalid={Boolean(fieldErrors.code)}
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          <label>
            New password
            <input
              type="password"
              autoComplete="new-password"
              minLength={8}
              maxLength={64}
              disabled={pending}
              aria-invalid={Boolean(fieldErrors.password)}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <label>
            Confirm new password
            <input
              type="password"
              autoComplete="new-password"
              minLength={8}
              maxLength={64}
              disabled={pending}
              aria-invalid={Boolean(fieldErrors.confirmation)}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
          <AuthErrors errors={[...Object.values(fieldErrors), requestError]} />
          {status ? <p className="auth-status" role="status" aria-live="polite">{status}</p> : null}
          <button type="submit" disabled={pending}>
            {pending ? "Resetting password..." : "Reset password"}
          </button>
        </form>
      )}
    </AuthPageFrame>
  );
}
