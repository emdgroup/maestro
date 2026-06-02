import { useState } from "react";
import { Label } from "@/ui/label";
import {
  Combobox,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
} from "@/ui/combobox";
import { useListLinearTeams } from "@/services/integration-lookup.service";

interface Props {
  fields: Record<string, string>;
  onFieldsChange: (fields: Record<string, string>) => void;
}

export function LinearForm({ fields, onFieldsChange }: Props) {
  const teamId = fields.team_id ?? "";
  const { data: teams = [], isLoading } = useListLinearTeams();
  const [search, setSearch] = useState("");

  const q = search.toLowerCase();
  const filteredTeams = q
    ? teams.filter((t) => t.key.toLowerCase().includes(q) || t.name.toLowerCase().includes(q))
    : teams;

  return (
    <div className="space-y-1.5">
      <Label className="text-sm font-medium">Team</Label>
      <Combobox
        value={teamId}
        onValueChange={(v) => onFieldsChange({ ...fields, team_id: v ?? "" })}
        onInputValueChange={(v) => setSearch(v)}
        filter={null}
      >
        <ComboboxInput
          placeholder={isLoading ? "Loading teams…" : "Search teams… (optional)"}
          showClear={!!teamId}
        />
        <ComboboxContent>
          <ComboboxList>
            {isLoading && <ComboboxEmpty>Loading…</ComboboxEmpty>}
            {!isLoading && teams.length === 0 && <ComboboxEmpty>No teams found</ComboboxEmpty>}
            {filteredTeams.map((t) => (
              <ComboboxItem key={t.id} value={t.id}>
                <span className="font-mono font-medium text-xs">{t.key}</span>
                <span className="text-muted-foreground">{t.name}</span>
              </ComboboxItem>
            ))}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      <p className="text-xs text-muted-foreground">Leave blank to import issues from all teams</p>
    </div>
  );
}
