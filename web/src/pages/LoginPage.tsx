import { ArrowRight } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import {
  AuthFeedback,
  AuthPageFrame,
  AuthPasswordField,
  safeAuthError,
  validateEmail,
  validatePassword,
} from "../auth/AuthForm";
import { useAuth } from "../auth/AuthProvider";
import { PrimaryCommand } from "../components/ui/CommandButton";

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
    if (errors.email || errors.password) {
      const firstInvalid = event.currentTarget.elements.namedItem(
        errors.email ? "email" : "login-password",
      );
      if (firstInvalid instanceof HTMLElement) firstInvalid.focus();
      return;
    }

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
      title="欢迎回来"
      description="继续完成你的下一部作品"
      footer={(
        <>
          <span>还没有账户？ <Link to="/register">免费注册</Link></span>
          <Link to="/forgot-password">找回账户</Link>
        </>
      )}
    >
      {auth.loading ? <p className="auth-session-status" role="status">正在检查登录状态...</p> : (
        <form className="auth-form" noValidate onSubmit={(event) => void handleSubmit(event)}>
          <div className="auth-field">
            <label htmlFor="login-email">邮箱</label>
            <input
              id="login-email"
              name="email"
              type="email"
              autoComplete="username"
              inputMode="email"
              maxLength={320}
              placeholder="creator@example.com"
              disabled={pending}
              aria-describedby="login-feedback"
              aria-invalid={Boolean(fieldErrors.email)}
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setFieldErrors((current) => ({ ...current, email: null }));
                setRequestError(null);
              }}
            />
          </div>
          <AuthPasswordField
            id="login-password"
            label="密码"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              setFieldErrors((current) => ({ ...current, password: null }));
              setRequestError(null);
            }}
            autoComplete="current-password"
            describedBy="login-feedback"
            disabled={pending}
            invalid={Boolean(fieldErrors.password)}
          />
          <AuthFeedback id="login-feedback" errors={[fieldErrors.email, fieldErrors.password, requestError]} />
          <PrimaryCommand type="submit" icon={<ArrowRight size={16} />} loading={pending}>
            {pending ? "正在登录..." : "登录"}
          </PrimaryCommand>
        </form>
      )}
    </AuthPageFrame>
  );
}
