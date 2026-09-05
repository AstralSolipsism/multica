// Scratch: probe which structural translator type the views TFunction satisfies.
import { useT } from "../../i18n";

type SmallShape = (
  selector: (resources: {
    quota: {
      window_short_minutes: string;
      window_short_hours: string;
      window_short_days: string;
      window_weekly: string;
    };
  }) => string,
  params?: { value?: number },
) => string;

type AnyShape = (
  selector: (resources: any) => string,
  params?: { value?: number },
) => string;

declare function takeSmall(t: SmallShape): void;
declare function takeAny(t: AnyShape): void;

export function Probe() {
  const { t } = useT("runtimes");
  takeAny(t);
  takeSmall(t);
  return null;
}
