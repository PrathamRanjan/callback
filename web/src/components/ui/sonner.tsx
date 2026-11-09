import { CircleCheckIcon, InfoIcon, Loader2Icon, OctagonXIcon, TriangleAlertIcon } from "lucide-react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useTheme } from "@/lib/theme";

const Toaster = ({ ...props }: ToasterProps) => {
  const { resolved } = useTheme();
  return (
    <Sonner
      theme={resolved}
      className="toaster group"
      position="top-center"
      icons={{
        success: <CircleCheckIcon className="size-4 text-done" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4 text-hold" />,
        error: <OctagonXIcon className="size-4 text-off" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--surface)",
          "--normal-text": "var(--ink)",
          "--normal-border": "var(--line)",
          "--border-radius": "10px",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
