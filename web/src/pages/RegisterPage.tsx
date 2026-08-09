import { ArrowRight, Mail } from "lucide-react";
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
import { OutlineCommand, PrimaryCommand } from "../components/ui/CommandButton";

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
      setStatus("验证码已发送，请检查收件箱和垃圾邮件。");
    } catch (error) {
      setRequestError(safeAuthError(error));
    } finally {
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
      confirmation: password === confirmation ? null : "两次输入的密码不一致。",
    };
    setFieldErrors(errors);
    setRequestError(null);
    setStatus(null);
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
    <AuthPageFrame
      title="创建创作者账户"
      description="从一个想法开始，建立完整的视频世界"
      footer={<span>已有账户？ <Link to="/login">直接登录</Link></span>}
    >
      {auth.loading ? <p className="auth-session-status" role="status">正在检查登录状态...</p> : (
        <form className="auth-form" noValidate onSubmit={(event) => void handleSubmit(event)}>
          <div className="auth-code-row">
            <div className="auth-field">
              <label htmlFor="register-email">邮箱</label>
              <input
                id="register-email"
                name="email"
                type="email"
                autoComplete="email"
                inputMode="email"
                maxLength={320}
                placeholder="creator@example.com"
                disabled={pending}
                aria-describedby="register-feedback"
                aria-invalid={Boolean(fieldErrors.email)}
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setFieldErrors((current) => ({ ...current, email: null }));
                  setRequestError(null);
                  setStatus(null);
                }}
              />
            </div>
            <OutlineCommand
              type="button"
              icon={<Mail size={16} />}
              loading={sendingCode}
              disabled={registering}
              onClick={() => void handleSendCode()}
            >
              {sendingCode ? "正在发送..." : "发送验证码"}
            </OutlineCommand>
          </div>
          <div className="auth-field">
            <label htmlFor="register-code">验证码</label>
            <input
              id="register-code"
              name="code"
              type="text"
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              disabled={pending}
              aria-describedby="register-feedback"
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
            id="register-password"
            label="设置密码"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              setFieldErrors((current) => ({ ...current, password: null, confirmation: null }));
              setRequestError(null);
            }}
            autoComplete="new-password"
            describedBy="register-feedback"
            disabled={pending}
            invalid={Boolean(fieldErrors.password)}
          />
          <AuthPasswordField
            id="register-confirmation"
            label="确认密码"
            value={confirmation}
            onChange={(event) => {
              setConfirmation(event.target.value);
              setFieldErrors((current) => ({ ...current, confirmation: null }));
              setRequestError(null);
            }}
            autoComplete="new-password"
            describedBy="register-feedback"
            disabled={pending}
            invalid={Boolean(fieldErrors.confirmation)}
          />
          <AuthFeedback id="register-feedback" errors={[...Object.values(fieldErrors), requestError]} status={status} />
          <PrimaryCommand type="submit" icon={<ArrowRight size={16} />} loading={registering} disabled={sendingCode}>
            {registering ? "正在创建..." : "创建账户"}
          </PrimaryCommand>
        </form>
      )}
    </AuthPageFrame>
  );
}
