import { useState, type FormEvent } from "react";
import { Link, Navigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { AuthErrors, AuthPageFrame, validateEmail } from "../auth/AuthForm";

export function ForgotPasswordPage() {
  const auth = useAuth();
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!auth.loading && auth.user) return <Navigate replace to="/projects" />;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const validationError = validateEmail(email);
    setEmailError(validationError);
    setStatus(null);
    if (validationError) return;

    setPending(true);
    try {
      await auth.requestPasswordReset(email.trim());
    } catch {
      // Reset requests always use the same account-neutral result.
    } finally {
      setStatus("If the account can be reset, a code will arrive shortly.");
      setPending(false);
    }
  }

  return (
    <AuthPageFrame
      title="Reset password"
      footer={(
        <>
          <Link to="/login">Sign in</Link>
          <Link to="/reset-password">Enter reset code</Link>
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
              aria-invalid={Boolean(emailError)}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <AuthErrors errors={[emailError]} />
          {status ? <p className="auth-status" role="status" aria-live="polite">{status}</p> : null}
          <button type="submit" disabled={pending}>
            {pending ? "Sending reset code..." : "Send reset code"}
          </button>
        </form>
      )}
    </AuthPageFrame>
  );
}
