export interface AuthUser {
  id: string;
  email: string;
  role: "user" | "admin";
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface RegisterInput extends LoginInput {
  code: string;
}

export interface ResetPasswordInput {
  email: string;
  code: string;
  new_password: string;
}

export interface AuthResponse {
  user: AuthUser;
  csrf_token: string;
}

export interface MeResponse {
  user: AuthUser;
  csrf_token?: string;
}

export interface CsrfResponse {
  csrf_token: string;
}
