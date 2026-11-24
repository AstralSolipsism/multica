"use client";

import { useMemo, useState } from "react";
import { LoaderCircle } from "@multica/ui/icons";
import { Button } from "@multica/ui/components/ui/button";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { Input } from "@multica/ui/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@multica/ui/components/ui/sheet";
import type { EngineeringConfig } from "@multica/core/api";
import type { MemberWithUser } from "@multica/core/types";
import { useT } from "../../i18n";
import { EngineeringSkills } from "./engineering-skills";
import type { StrixnovaSkillBinding } from "./engineering-utils";

interface EngineeringSettingsProps {
  config: EngineeringConfig;
  members: readonly MemberWithUser[];
  pending: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  skillBindings: readonly StrixnovaSkillBinding[];
  skillsLoading: boolean;
  skillsError: boolean;
  onSkillsRetry: () => void;
  canEdit: boolean;
  onChange: (data: { enabled?: boolean; deciderMemberIds?: string[] }) => void;
}

export function EngineeringSettings({ config, members, pending, open, onOpenChange, skillBindings, skillsLoading, skillsError, onSkillsRetry, canEdit, onChange }: EngineeringSettingsProps) {
  const { t } = useT("engineering");
  const [query, setQuery] = useState("");
  const visibleMembers = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized ? members.filter((member) => `${member.name} ${member.email ?? ""}`.toLocaleLowerCase().includes(normalized)) : members;
  }, [members, query]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" overlayClassName="bg-black/24 supports-backdrop-filter:backdrop-blur-none" className="w-[396px] max-w-[92%] gap-0 p-0 sm:max-w-[396px]" data-engineering-region="settings">
        <SheetHeader className="border-b pr-12">
          <SheetTitle className="flex items-center gap-2">{pending ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}{t(($) => $.settings.title)}</SheetTitle>
          <SheetDescription>{t(($) => $.messages.serverAuthoritative)}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <section className="border-b p-4">
            <fieldset>
              <legend className="font-medium">{t(($) => $.settings.decidersLabel)}</legend>
              <p className="mt-1 text-caption text-muted-foreground">{t(($) => $.settings.decidersHint)}</p>
              <Input className="mt-3" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t(($) => $.settings.searchMembers)} aria-label={t(($) => $.settings.searchMembers)} />
              <div className="mt-2 max-h-43 overflow-y-auto border-y">
                {visibleMembers.map((member) => {
                  const alwaysIncluded = member.role === "owner" || member.role === "admin";
                  const checked = alwaysIncluded || config.deciderMemberIds.includes(member.user_id);
                  return (
                    <label key={member.id} className="flex min-h-10 items-center gap-3 border-b py-2 text-label last:border-b-0">
                      <Checkbox
                        checked={checked}
                        disabled={!canEdit || pending || alwaysIncluded}
                        onCheckedChange={() => {
                          const next = new Set(config.deciderMemberIds);
                          if (checked) next.delete(member.user_id); else next.add(member.user_id);
                          onChange({ deciderMemberIds: [...next] });
                        }}
                      />
                      <span className="min-w-0 flex-1 truncate">{member.name}</span>
                      {alwaysIncluded ? <span className="text-caption text-muted-foreground">{member.role}</span> : null}
                    </label>
                  );
                })}
                {!visibleMembers.length ? <p className="py-4 text-center text-caption text-muted-foreground">{t(($) => $.settings.noMembers)}</p> : null}
              </div>
            </fieldset>
          </section>
          <div className="border-b p-4">
            <EngineeringSkills bindings={skillBindings} loading={skillsLoading} error={skillsError} onRetry={onSkillsRetry} />
          </div>
          {canEdit ? <section className="p-4" data-engineering-disable>
            <h2 className="text-label font-medium text-muted-foreground">{t(($) => $.settings.disableTitle)}</h2>
            <p className="mt-1 text-caption text-muted-foreground">{t(($) => $.settings.disableHint)}</p>
            <Button type="button" variant="ghost" size="sm" className="mt-3 text-destructive hover:text-destructive" disabled={pending} onClick={() => onChange({ enabled: false })}>{t(($) => $.settings.disableAction)}</Button>
          </section> : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
