import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { AuthRequestError } from "./api";
import "./auth.css";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const codePattern = /^\d{6}$/;

export function validateEmail(value: string): string | null {
  return emailPattern.test(value.trim()) ? null : "Enter a valid email address.";
}

export function validatePassword(value: string): string | null {
  if (value.length < 8 || value.length > 64) {
    return "Password must be between 8 and 64 characters.";
  }
  return null;
}

export function validateCode(value: string): string | null {
  return codePattern.test(value) ? null : "Enter the six-digit code.";
}

export function safeAuthError(error: unknown): string {
  return error instanceof AuthRequestError
    ? error.message
    : "The request could not be completed.";
}

export function AuthPageFrame({
  title,
  children,
  footer,
}: {
  title: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <main className="auth-page">
      <section className="auth-panel" aria-labelledby="auth-page-title">
        <Link className="auth-brand" to="/projects">OpenMontage</Link>
        <h1 id="auth-page-title">{title}</h1>
        {children}
        <div className="auth-footer">{footer}</div>
      </section>
    </main>
  );
}

export function AuthErrors({ errors }: { errors: Array<string | null | undefined> }) {
  const messages = Array.from(new Set(errors.filter((message): message is string => Boolean(message))));
  if (messages.length === 0) return null;
  return (
    <div className="auth-error" role="alert" aria-live="assertive">
      {messages.map((message) => <p key={message}>{message}</p>)}
    </div>
  );
}
