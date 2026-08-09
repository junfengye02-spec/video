import { ArrowRight, Check } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, Navigate } from "react-router-dom";
import {
  AuthFeedback,
  AuthPageFrame,
  AuthPasswordField,
  safeAuthError,
  validateCode,
  validateEmail,
  validatePassword,
} from "../auth/AuthForm";
import { useAuth } from "../auth/AuthProvider";
import { PrimaryCommand } from "../components/ui/CommandButton";

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
  const [completed, setCompleted] = useState(false);
  const disabled = pending || completed;

  if (!auth.loading && auth.user) return <Navigate replace to="/projects" />;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    const errors = {
      email: validateEmail(email),
      code: validateCode(code),
      password: validatePassword(password),
      confirmation: password === confirmation ? null : "两次输入的密码不一致。",
    };
    setFieldErrors(errors);
    setRequestError(null);
    setStatus(null);
    if (Object.values(errors).some(Boolean)) return;

    setPending(true);
    try {
      await auth.resetPassword({ email: email.trim(), code, new_password: password });
      setCompleted(true);
      setStatus("密码已重置，现在可以返回登录。");
    } catch (error) {
      setRequestError(safeAuthError(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthPageFrame
      title="设置新密码"
      description="输入邮箱、验证码和新的登录密码"
      footer={<Link to="/login">返回登录</Link>}
    >
      {auth.loading ? <p className="auth-session-status" role="status">正在检查登录状态...</p> : (
        <form className="auth-form" noValidate onSubmit={(event) => void handleSubmit(event)}>
          <div className="auth-field">
            <label htmlFor="reset-email">邮箱</label>
            <input
              id="reset-email"
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              maxLength={320}
              placeholder="creator@example.com"
              disabled={disabled}
              aria-describedby="reset-feedback"
              aria-invalid={Boolean(fieldErrors.email)}
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setFieldErrors((current) => ({ ...current, email: null }));
                setRequestError(null);
              }}
            />
          </div>
          <div className="auth-field">
            <label htmlFor="reset-code">验证码</label>
            <input
              id="reset-code"
              name="code"
              type="text"
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              disabled={disabled}
              aria-describedby="reset-feedback"
              aria-invalid={Boolean(fieldErrors.code)}
              value={code}
              onChange={(event) => {
                setCode(event.target.value);
                setFieldErrors((current) => ({ ...current, code: null }));
                setRequestError(null);
              }}
            />
          </div>
          <AuthPasswordField
            id="reset-password"
            label="新密码"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              setFieldErrors((current) => ({ ...current, password: null, confirmation: null }));
              setRequestError(null);
            }}
            autoComplete="new-password"
            describedBy="reset-feedback"
            disabled={disabled}
            invalid={Boolean(fieldErrors.password)}
          />
          <AuthPasswordField
            id="reset-confirmation"
            label="确认新密码"
            value={confirmation}
            onChange={(event) => {
              setConfirmation(event.target.value);
              setFieldErrors((current) => ({ ...current, confirmation: null }));
              setRequestError(null);
            }}
            autoComplete="new-password"
            describedBy="reset-feedback"
            disabled={disabled}
            invalid={Boolean(fieldErrors.confirmation)}
          />
          <AuthFeedback id="reset-feedback" errors={[...Object.values(fieldErrors), requestError]} status={status} />
          <PrimaryCommand
            type="submit"
            icon={completed ? <Check size={16} /> : <ArrowRight size={16} />}
            loading={pending}
            disabled={completed}
          >
            {pending ? "正在重置..." : completed ? "密码已重置" : "确认重置密码"}
          </PrimaryCommand>
        </form>
      )}
    </AuthPageFrame>
  );
}
