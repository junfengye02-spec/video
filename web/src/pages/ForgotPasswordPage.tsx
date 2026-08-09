import { Mail } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, Navigate } from "react-router-dom";
import { AuthFeedback, AuthPageFrame, validateEmail } from "../auth/AuthForm";
import { useAuth } from "../auth/AuthProvider";
import { PrimaryCommand } from "../components/ui/CommandButton";

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
      // Reset lookups intentionally return the same account-neutral result.
    } finally {
      setStatus("如果该账户可以重置，你会很快收到验证码。");
      setPending(false);
    }
  }

  return (
    <AuthPageFrame
      title="找回你的创作空间"
      description="输入注册邮箱，我们会发送 6 位验证码"
      footer={(
        <>
          <Link to="/login">返回登录</Link>
          <Link to="/reset-password">已有验证码</Link>
        </>
      )}
    >
      {auth.loading ? <p className="auth-session-status" role="status">正在检查登录状态...</p> : (
        <form className="auth-form" noValidate onSubmit={(event) => void handleSubmit(event)}>
          <div className="auth-field">
            <label htmlFor="recovery-email">邮箱</label>
            <input
              id="recovery-email"
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              maxLength={320}
              placeholder="creator@example.com"
              disabled={pending}
              aria-describedby="recovery-feedback"
              aria-invalid={Boolean(emailError)}
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setEmailError(null);
                setStatus(null);
              }}
            />
          </div>
          <AuthFeedback id="recovery-feedback" errors={[emailError]} status={status} />
          <PrimaryCommand type="submit" icon={<Mail size={16} />} loading={pending}>
            {pending ? "正在发送..." : "发送重置验证码"}
          </PrimaryCommand>
        </form>
      )}
    </AuthPageFrame>
  );
}
