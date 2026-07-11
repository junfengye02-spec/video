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

export function RegisterPage() {
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
  const [sendingCode, setSendingCode] = useState(false);
  const [registering, setRegistering] = useState(false);
  const pending = sendingCode || registering;

  if (!auth.loading && auth.user) return <Navigate replace to="/projects" />;

  async function handleSendCode() {
    if (pending) return;
    const emailError = validateEmail(email);
    setFieldErrors((current) => ({ ...current, email: emailError }));
    setRequestError(null);
    setStatus(null);
    if (emailError) return;

    setSendingCode(true);
    try {
      await auth.sendVerification(email.trim());
    } catch {
      // The same outcome is shown to avoid exposing registration state.
    } finally {
      setStatus("If this address can receive a code, it will arrive shortly.");
      setSendingCode(false);
    }
  }

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
    if (Object.values(errors).some(Boolean)) return;

    setRegistering(true);
    try {
      await auth.register({ email: email.trim(), password, code });
    } catch (error) {
      setRequestError(safeAuthError(error));
    } finally {
      setRegistering(false);
    }
  }

  return (
    <AuthPageFrame title="Create account" footer={<Link to="/login">Sign in</Link>}>
      {auth.loading ? <p className="auth-status" role="status">Checking your session...</p> : (
        <form className="auth-form" noValidate onSubmit={(event) => void handleSubmit(event)}>
          <div className="auth-code-row">
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
            <button type="button" disabled={pending} onClick={() => void handleSendCode()}>
              {sendingCode ? "Sending code..." : "Send code"}
            </button>
          </div>
          <label>
            Verification code
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
            Password
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
            Confirm password
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
            {registering ? "Creating account..." : "Create account"}
          </button>
        </form>
      )}
    </AuthPageFrame>
  );
}
