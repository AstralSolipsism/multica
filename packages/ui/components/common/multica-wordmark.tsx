import { cn } from "../../lib/utils";

interface MulticaWordmarkProps extends React.ComponentProps<"svg"> {
  writeDelayMs?: number;
  hop?: boolean;
  title?: string;
}

/** Keep the upstream sizing API while rendering the fork's product name. */
export function MulticaWordmark({
  writeDelayMs,
  hop = false,
  title = "Labrastro",
  className,
  style,
  ...props
}: MulticaWordmarkProps) {
  return (
    <svg
      viewBox="0 0 142 28"
      role="img"
      aria-label={title}
      fill="currentColor"
      className={cn(
        "inline-block h-[1em] w-auto shrink-0 overflow-visible",
        writeDelayMs != null && "multica-fade-in",
        hop && "hover:opacity-80",
        className,
      )}
      style={{ ...(writeDelayMs != null && { animationDelay: `${writeDelayMs}ms` }), ...style }}
      {...props}
    >
      <text x="0" y="22" fontFamily="system-ui, sans-serif" fontSize="26" fontWeight="650">
        Labrastro
      </text>
    </svg>
  );
}
