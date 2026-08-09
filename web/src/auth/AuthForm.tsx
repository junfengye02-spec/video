import { Eye, EyeOff } from "lucide-react";
import { useState, type ChangeEventHandler, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { MiseLogo } from "../components/brand/MiseLogo";
import { IconButton } from "../components/ui/CommandButton";
import { AuthRequestError, type AuthErrorCode } from "./api";
import "./auth.css";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const codePattern = /^\d{6}$/;

const requestMessages: Record<AuthErrorCode, string> = {
  network: "暂时无法连接，请稍后重试。",
  unauthorized: "邮箱或密码不正确，请重新输入。",
  forbidden: "当前账户无法完成此操作。",
  session_invalid: "浏览器会话已失效，请重试。",
  csrf_invalid: "浏览器会话已失效，请重试。",
  validation: "请检查填写的信息后重试。",
  conflict: "账户状态已发生变化，请刷新后重试。",
  rate_limited: "尝试次数过多，请稍后再试。",
  email_domain_unavailable: "该邮箱域名无法接收邮件，请检查邮箱地址。",
  email_delivery_unavailable: "邮件服务尚未配置，请联系管理员。",
  email_delivery_failed: "验证码邮件发送失败，请稍后再试。",
  server: "服务暂时不可用，请稍后重试。",
  request_failed: "暂时无法完成请求，请稍后重试。",
  invalid_response: "暂时无法完成请求，请稍后重试。",
};

export function validateEmail(value: string): string | null {
  return emailPattern.test(value.trim()) ? null : "请输入有效的邮箱地址。";
}

export function validatePassword(value: string): string | null {
  if (value.length < 8 || value.length > 64) {
    return "密码长度需为 8 至 64 个字符。";
  }
  return null;
}

export function validateCode(value: string): string | null {
  return codePattern.test(value) ? null : "请输入 6 位数字验证码。";
}

export function safeAuthError(error: unknown): string {
  return error instanceof AuthRequestError
    ? requestMessages[error.code]
    : "暂时无法完成请求，请稍后重试。";
}

export function AuthPageFrame({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <main className="auth-page">
      <header className="auth-site-header">
        <Link className="auth-brand" to="/projects" aria-label="mise studio">
          <MiseLogo />
        </Link>
        <span>让想法入镜</span>
      </header>
      <div className="auth-page-body">
        <section className="auth-panel" aria-labelledby="auth-page-title">
          <div className="auth-heading">
            <MiseLogo compact aria-hidden="true" />
            <h1 id="auth-page-title">{title}</h1>
            <p>{description}</p>
          </div>
          {children}
          <div className="auth-footer">{footer}</div>
        </section>
      </div>
    </main>
  );
}

export function AuthFeedback({
  id,
  errors,
  status,
}: {
  id: string;
  errors: Array<string | null | undefined>;
  status?: string | null;
}) {
  const messages = Array.from(new Set(errors.filter((message): message is string => Boolean(message))));

  return (
    <div id={id} className="auth-feedback-slot" data-empty={messages.length === 0 && !status ? "true" : undefined}>
      {messages.length > 0 ? (
        <div className="auth-error" role="alert" aria-live="assertive">
          {messages.map((message) => <p key={message}>{message}</p>)}
        </div>
      ) : null}
      {messages.length === 0 && status ? (
        <p className="auth-status" role="status" aria-live="polite">{status}</p>
      ) : null}
    </div>
  );
}

export function AuthPasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  describedBy,
  disabled = false,
  invalid = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: ChangeEventHandler<HTMLInputElement>;
  autoComplete: "current-password" | "new-password";
  describedBy?: string;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const visibilityLabel = visible ? `隐藏${label}` : `显示${label}`;

  return (
    <div className="auth-field">
      <label htmlFor={id}>{label}</label>
      <div className="auth-password-control">
        <input
          id={id}
          name={id}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          minLength={8}
          maxLength={64}
          disabled={disabled}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          value={value}
          onChange={onChange}
        />
        <IconButton
          className="auth-password-toggle"
          label={visibilityLabel}
          icon={visible ? <EyeOff size={18} /> : <Eye size={18} />}
          aria-pressed={visible}
          disabled={disabled}
          onClick={() => setVisible((current) => !current)}
        />
      </div>
    </div>
  );
}
