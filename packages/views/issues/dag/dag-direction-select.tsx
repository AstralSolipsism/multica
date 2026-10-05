import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multica/ui/components/ui/select";
import {
  DAG_DIRECTION_OPTIONS,
  dagDirectionLabelKey,
  type DagDirection,
} from "@multica/core/issues/stores/view-store";
import { useT } from "../../i18n";

export function DagDirectionSelect({
  value,
  onChange,
  className,
  align = "end",
}: {
  value: DagDirection;
  onChange: (value: DagDirection) => void;
  className?: string;
  align?: "start" | "end";
}) {
  const { t } = useT("dag");
  const items = DAG_DIRECTION_OPTIONS.map((direction) => ({
    value: direction,
    label: t(($) => $[dagDirectionLabelKey(direction)]),
  }));
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next);
      }}
    >
      <SelectTrigger
        size="sm"
        className={className}
        aria-label={t(($) => $.direction_label)}
      >
        <SelectValue>{t(($) => $[dagDirectionLabelKey(value)])}</SelectValue>
      </SelectTrigger>
      <SelectContent align={align}>
        <SelectGroup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
