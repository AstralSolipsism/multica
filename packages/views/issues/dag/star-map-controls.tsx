"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  Check,
  ChevronRight,
  CircleDot,
  Layers,
  Link,
  ListTree,
  Network,
  Search,
} from "@multica/ui/icons";
import { Button } from "@multica/ui/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@multica/ui/components/ui/popover";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import "./star-map-controls.css";

export type StarMapLayoutMode = "cluster" | "polar";
export type StarMapFocusIntent = "line" | "chain";
export type StarMapScale = "macro" | "meso" | "linear";

export interface StarMapLayers {
  manual: boolean;
  wakeup: boolean;
  mention: boolean;
  stage: boolean;
  completed: boolean;
}

export interface StarMapSearchResult {
  id: string;
  identifier: string;
  title: string;
}

export interface StarMapControlsProps {
  layout: StarMapLayoutMode;
  onLayoutChange: (layout: StarMapLayoutMode) => void;
  intent: StarMapFocusIntent;
  onIntentChange: (intent: StarMapFocusIntent) => void;
  scale: StarMapScale;
  onScaleChange: (scale: StarMapScale) => void;
  orbiting: boolean;
  onToggleOrbit: () => void;
  linking: boolean;
  onToggleLinking: () => void;
  layers: StarMapLayers;
  onToggleLayer: (key: keyof StarMapLayers) => void;
  query: string;
  onQueryChange: (query: string) => void;
  results: StarMapSearchResult[];
  onLocate: (id: string) => void;
  rootLabel?: string;
  focusLabel?: string;
  onHome: () => void;
  onOpenLegacy: () => void;
  status?: string;
}

export function StarMapControls({
  layout,
  onLayoutChange,
  intent,
  onIntentChange,
  scale,
  onScaleChange,
  orbiting,
  onToggleOrbit,
  linking,
  onToggleLinking,
  layers,
  onToggleLayer,
  query,
  onQueryChange,
  results,
  onLocate,
  rootLabel,
  focusLabel,
  onHome,
  onOpenLegacy,
  status,
}: StarMapControlsProps) {
  const { t } = useT("dag");
  const listboxId = useId();
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const searchVisible = searchOpen && query.trim().length > 0;
  const selectedIndex =
    results.length === 0 ? -1 : Math.min(Math.max(activeIndex, 0), results.length - 1);

  useEffect(() => {
    if (searchVisible && selectedIndex >= 0) {
      optionRefs.current[selectedIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [searchVisible, selectedIndex]);

  const locate = (id: string) => {
    onLocate(id);
    setSearchOpen(false);
    setActiveIndex(-1);
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setSearchOpen(true);
      if (results.length > 0) {
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((selectedIndex + delta + results.length) % results.length);
      }
      return;
    }
    if (event.key === "Enter" && searchVisible && selectedIndex >= 0) {
      const result = results[selectedIndex];
      if (result) {
        event.preventDefault();
        locate(result.id);
      }
      return;
    }
    if (event.key === "Escape" && searchVisible) {
      event.preventDefault();
      event.stopPropagation();
      setSearchOpen(false);
      setActiveIndex(-1);
    }
  };

  const allSpaceLabel = t(($) => $.star_map.all_space);
  const searchLabel = t(($) => $.star_map.search_placeholder);
  const layerOptions = [
    {
      key: "manual",
      label: t(($) => $.star_map.layer_manual),
      swatch: "manual",
    },
    {
      key: "stage",
      label: t(($) => $.star_map.layer_stage),
      swatch: "stage",
    },
    {
      key: "wakeup",
      label: t(($) => $.star_map.layer_wakeup),
      swatch: "wakeup",
    },
    {
      key: "mention",
      label: t(($) => $.star_map.layer_mention),
      swatch: "mention",
    },
    {
      key: "completed",
      label: t(($) => $.star_map.layer_completed),
      swatch: "completed",
    },
  ] satisfies { key: keyof StarMapLayers; label: string; swatch: string }[];

  return (
    <div className="star-map-controls">
      <header className="star-map-controls__top">
        <div className="star-map-controls__island star-map-controls__navigation">
          <span className="star-map-controls__brand" aria-hidden />
          <nav className="star-map-controls__crumbs" aria-label={allSpaceLabel}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="star-map-controls__crumb"
              aria-label={allSpaceLabel}
              onClick={onHome}
            >
              {allSpaceLabel}
            </Button>
            {rootLabel && (
              <>
                <ChevronRight className="star-map-controls__chevron" aria-hidden />
                <span
                  className="star-map-controls__current"
                  aria-current={focusLabel ? undefined : "page"}
                  title={rootLabel}
                >
                  {rootLabel}
                </span>
              </>
            )}
            {focusLabel && (
              <>
                <ChevronRight className="star-map-controls__chevron" aria-hidden />
                <span
                  className="star-map-controls__current star-map-controls__current--focus"
                  aria-current="page"
                  title={focusLabel}
                >
                  {focusLabel}
                </span>
              </>
            )}
          </nav>
        </div>

        <div className="star-map-controls__island star-map-controls__modes">
          <div
            className="star-map-controls__segments"
            role="group"
            aria-label={`${t(($) => $.star_map.layout_cluster)} / ${t(($) => $.star_map.layout_polar)}`}
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn("star-map-controls__segment", layout === "cluster" && "is-active")}
              aria-label={t(($) => $.star_map.layout_cluster)}
              aria-pressed={layout === "cluster"}
              onClick={() => onLayoutChange("cluster")}
            >
              {t(($) => $.star_map.layout_cluster)}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn("star-map-controls__segment", layout === "polar" && "is-active")}
              aria-label={t(($) => $.star_map.layout_polar)}
              aria-pressed={layout === "polar"}
              onClick={() => onLayoutChange("polar")}
            >
              {t(($) => $.star_map.layout_polar)}
            </Button>
          </div>
          <span className="star-map-controls__divider" aria-hidden />
          <div
            className="star-map-controls__segments"
            role="group"
            aria-label={`${t(($) => $.star_map.intent_line)} / ${t(($) => $.star_map.intent_chain)}`}
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn("star-map-controls__segment", intent === "line" && "is-active")}
              aria-label={t(($) => $.star_map.intent_line)}
              aria-pressed={intent === "line"}
              onClick={() => onIntentChange("line")}
            >
              {t(($) => $.star_map.intent_line)}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn("star-map-controls__segment", intent === "chain" && "is-active")}
              aria-label={t(($) => $.star_map.intent_chain)}
              aria-pressed={intent === "chain"}
              onClick={() => onIntentChange("chain")}
            >
              {t(($) => $.star_map.intent_chain)}
            </Button>
          </div>
        </div>

        <div className="star-map-controls__island star-map-controls__actions">
          <div
            className="star-map-controls__search"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) {
                setSearchOpen(false);
              }
            }}
          >
            <Search className="star-map-controls__search-icon" aria-hidden />
            <input
              className="star-map-controls__search-input"
              type="search"
              role="combobox"
              aria-label={searchLabel}
              aria-autocomplete="list"
              aria-haspopup="listbox"
              aria-expanded={searchVisible}
              aria-controls={listboxId}
              aria-activedescendant={
                searchVisible && selectedIndex >= 0
                  ? `${listboxId}-${selectedIndex}`
                  : undefined
              }
              placeholder={searchLabel}
              autoComplete="off"
              value={query}
              onFocus={() => setSearchOpen(true)}
              onChange={(event) => {
                onQueryChange(event.target.value);
                setSearchOpen(true);
                setActiveIndex(event.target.value.trim() ? 0 : -1);
              }}
              onKeyDown={onSearchKeyDown}
            />
            {searchVisible && (
              <div className="star-map-controls__search-panel">
                {results.length > 0 ? (
                  <div
                    id={listboxId}
                    className="star-map-controls__results"
                    role="listbox"
                    aria-label={searchLabel}
                  >
                    {results.map((result, index) => (
                      <button
                        id={`${listboxId}-${index}`}
                        key={result.id}
                        ref={(element) => {
                          optionRefs.current[index] = element;
                        }}
                        type="button"
                        role="option"
                        aria-selected={selectedIndex === index}
                        aria-label={`${result.identifier} ${result.title}`}
                        className={cn(
                          "star-map-controls__result",
                          selectedIndex === index && "is-active",
                        )}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => setActiveIndex(index)}
                        onFocus={() => setActiveIndex(index)}
                        onClick={() => locate(result.id)}
                      >
                        <span className="star-map-controls__result-id">{result.identifier}</span>
                        <span className="star-map-controls__result-title">{result.title}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="star-map-controls__empty" role="status">
                    {t(($) => $.star_map.no_results)}
                  </div>
                )}
              </div>
            )}
          </div>
          <span className="star-map-controls__divider" aria-hidden />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn("star-map-controls__action", orbiting && "is-active")}
            aria-label={t(($) => $.star_map.orbit)}
            aria-pressed={orbiting}
            onClick={onToggleOrbit}
          >
            <CircleDot className="star-map-controls__icon" aria-hidden />
            <span className="star-map-controls__action-label">{t(($) => $.star_map.orbit)}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn("star-map-controls__action", linking && "is-active")}
            aria-label={t(($) => $.star_map.link)}
            aria-pressed={linking}
            onClick={onToggleLinking}
          >
            <Link className="star-map-controls__icon" aria-hidden />
            <span className="star-map-controls__action-label">{t(($) => $.star_map.link)}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="star-map-controls__action"
            aria-label={t(($) => $.star_map.legacy)}
            onClick={onOpenLegacy}
          >
            <ListTree className="star-map-controls__icon" aria-hidden />
            <span className="star-map-controls__action-label">{t(($) => $.star_map.legacy)}</span>
          </Button>
        </div>
      </header>

      <div className="star-map-controls__bottom">
        <div className="star-map-controls__island star-map-controls__legend">
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="star-map-controls__action star-map-controls__layers-trigger"
                  aria-label={t(($) => $.star_map.layers)}
                />
              }
            >
              <Layers className="star-map-controls__icon" aria-hidden />
              <span>{t(($) => $.star_map.layers)}</span>
            </PopoverTrigger>
            <PopoverContent
              side="top"
              align="start"
              sideOffset={8}
              className="star-map-controls__popover"
              aria-label={t(($) => $.star_map.layers)}
            >
              <div className="star-map-controls__popover-title">
                {t(($) => $.star_map.layers)}
              </div>
              {layerOptions.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  className="star-map-controls__layer"
                  aria-label={option.label}
                  aria-pressed={layers[option.key]}
                  onClick={() => onToggleLayer(option.key)}
                >
                  <span
                    className={`star-map-controls__swatch star-map-controls__swatch--${option.swatch}`}
                    aria-hidden
                  />
                  <span>{option.label}</span>
                  <Check
                    className={cn(
                      "star-map-controls__layer-check",
                      layers[option.key] && "is-visible",
                    )}
                    aria-hidden
                  />
                </button>
              ))}
            </PopoverContent>
          </Popover>
          <span className="star-map-controls__divider" aria-hidden />
          <div className="star-map-controls__statuses" aria-label={status}>
            <span className="star-map-controls__status-key">
              <span className="star-map-controls__status-dot star-map-controls__status-dot--running" aria-hidden />
              {t(($) => $.star_map.legend_running)}
            </span>
            <span className="star-map-controls__status-key">
              <span className="star-map-controls__status-dot star-map-controls__status-dot--review" aria-hidden />
              {t(($) => $.star_map.legend_review)}
            </span>
            <span className="star-map-controls__status-key">
              <span className="star-map-controls__status-dot star-map-controls__status-dot--blocked" aria-hidden />
              {t(($) => $.star_map.legend_blocked)}
            </span>
            <span className="star-map-controls__status-key">
              <span className="star-map-controls__status-dot star-map-controls__status-dot--todo" aria-hidden />
              {t(($) => $.star_map.legend_todo)}
            </span>
          </div>
          {status && <span className="star-map-controls__status-text" role="status">{status}</span>}
        </div>

        <div
          className="star-map-controls__island star-map-controls__scale"
          role="group"
          aria-label={`${t(($) => $.star_map.macro)} / ${t(($) => $.star_map.meso)} / ${t(($) => $.star_map.linear)}`}
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn("star-map-controls__scale-button", scale === "macro" && "is-active")}
            aria-label={t(($) => $.star_map.macro)}
            aria-pressed={scale === "macro"}
            onClick={() => onScaleChange("macro")}
          >
            <Network className="star-map-controls__icon star-map-controls__scale-icon" aria-hidden />
            <span>{t(($) => $.star_map.macro)}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn("star-map-controls__scale-button", scale === "meso" && "is-active")}
            aria-label={t(($) => $.star_map.meso)}
            aria-pressed={scale === "meso"}
            onClick={() => onScaleChange("meso")}
          >
            <CircleDot className="star-map-controls__icon star-map-controls__scale-icon" aria-hidden />
            <span>{t(($) => $.star_map.meso)}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn("star-map-controls__scale-button", scale === "linear" && "is-active")}
            aria-label={t(($) => $.star_map.linear)}
            aria-pressed={scale === "linear"}
            onClick={() => onScaleChange("linear")}
          >
            <ListTree className="star-map-controls__icon star-map-controls__scale-icon" aria-hidden />
            <span>{t(($) => $.star_map.linear)}</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
