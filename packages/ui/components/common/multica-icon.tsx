import { cn } from "../../lib/utils";

export type MulticaIconMode = "static" | "think" | "intro" | "launch";

interface MulticaIconProps extends Omit<React.ComponentProps<"svg">, "mode"> {
  mode?: MulticaIconMode;
  shape?: "square" | "circle";
  size?: number;
  title?: string;
}

/** Labrastro's retained paw geometry with the upstream icon call contract. */
export function MulticaIcon({
  mode = "static",
  shape = "square",
  size,
  title,
  className,
  style,
  ...props
}: MulticaIconProps) {
  return (
    <svg
      viewBox="0 0 100 100"
      fill="currentColor"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className={cn(
        "inline-block shrink-0",
        size == null && "size-[1em]",
        shape === "circle" && "rounded-full",
        (mode === "think" || mode === "launch") && "animate-pulse",
        mode === "intro" && "multica-pop",
        className,
      )}
      style={{ ...(size != null && { width: size, height: size }), ...style }}
      {...props}
    >
      <ellipse cx="18.5" cy="42" rx="10.5" ry="14" transform="rotate(-24 18.5 42)" />
      <ellipse cx="38.5" cy="27" rx="10.5" ry="14" transform="rotate(-8 38.5 27)" />
      <ellipse cx="61.5" cy="27" rx="10.5" ry="14" transform="rotate(8 61.5 27)" />
      <ellipse cx="81.5" cy="42" rx="10.5" ry="14" transform="rotate(24 81.5 42)" />
      <ellipse cx="50" cy="70" rx="24" ry="19" />
    </svg>
  );
}
