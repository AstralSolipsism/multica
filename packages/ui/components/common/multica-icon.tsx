import { useState, useEffect } from "react";
import { cn } from "../../lib/utils";

interface MulticaIconProps extends React.ComponentProps<"span"> {
  /**
   * If true, play a one-time entrance spin animation.
   */
  animate?: boolean;
  /**
   * If true, disable hover spin animation.
   */
  noSpin?: boolean;
  /**
   * If true, show a border around the icon.
   */
  bordered?: boolean;
  /**
   * Size of the bordered icon: "sm" (default), "md", "lg"
   */
  size?: "sm" | "md" | "lg";
}

const borderedSizes = {
  sm: { wrapper: "p-1.5", icon: "size-3.5" },
  md: { wrapper: "p-2", icon: "size-4" },
  lg: { wrapper: "p-2.5", icon: "size-5" },
};

/**
 * Paw-print icon matching the Labrastro logo (same geometry as
 * /favicon.svg's mark). Inline SVG with `fill: currentColor` so it adapts to
 * light/dark themes automatically.
 */
export function MulticaIcon({
  className,
  animate = false,
  noSpin = false,
  bordered = false,
  size = "sm",
  ...props
}: MulticaIconProps) {
  const [entranceDone, setEntranceDone] = useState(!animate);

  useEffect(() => {
    if (!animate) return;
    const timer = setTimeout(() => setEntranceDone(true), 600);
    return () => clearTimeout(timer);
  }, [animate]);

  const mark = (
    <svg
      viewBox="0 0 100 100"
      className="block size-full"
      fill="currentColor"
      aria-hidden="true"
    >
      <ellipse cx="18.5" cy="42" rx="10.5" ry="14" transform="rotate(-24 18.5 42)" />
      <ellipse cx="38.5" cy="27" rx="10.5" ry="14" transform="rotate(-8 38.5 27)" />
      <ellipse cx="61.5" cy="27" rx="10.5" ry="14" transform="rotate(8 61.5 27)" />
      <ellipse cx="81.5" cy="42" rx="10.5" ry="14" transform="rotate(24 81.5 42)" />
      <ellipse cx="50" cy="70" rx="24" ry="19" />
    </svg>
  );

  if (bordered) {
    const sizeConfig = borderedSizes[size];
    return (
      <span
        className={cn(
          "inline-flex items-center justify-center border border-border rounded-md",
          sizeConfig.wrapper,
          className
        )}
        aria-hidden="true"
        {...props}
      >
        <span
          className={cn(
            "block",
            sizeConfig.icon,
            !entranceDone && "animate-entrance-spin",
            entranceDone && !noSpin && "hover:animate-spin"
          )}
        >
          {mark}
        </span>
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-block size-[1em]",
        !entranceDone && "animate-entrance-spin",
        entranceDone && !noSpin && "hover:animate-spin",
        className
      )}
      aria-hidden="true"
      {...props}
    >
      {mark}
    </span>
  );
}
