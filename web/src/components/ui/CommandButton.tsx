import type { ButtonHTMLAttributes, ReactNode } from "react";
import {
  Button,
  IconButton as SharedIconButton,
  type IconButtonProps as SharedIconButtonProps,
} from "../../shared/ui";

type CommandButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode;
  loading?: boolean;
};

function CommandButton({
  children,
  className = "",
  disabled,
  icon,
  loading = false,
  tone,
  ...props
}: CommandButtonProps & { tone: "primary" | "outline" }) {
  return (
    <Button
      className={`async-action ${className}`.trim()}
      disabled={disabled}
      icon={icon}
      loading={loading}
      variant={tone === "primary" ? "primary" : "secondary"}
      {...props}
    >
      {children}
    </Button>
  );
}

export function PrimaryCommand(props: CommandButtonProps) {
  return <CommandButton tone="primary" {...props} />;
}

export function OutlineCommand(props: CommandButtonProps) {
  return <CommandButton tone="outline" {...props} />;
}

export type IconButtonProps = SharedIconButtonProps;
export const IconButton = SharedIconButton;
