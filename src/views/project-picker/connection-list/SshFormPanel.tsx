import { useState } from "react";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { PanelHeader } from "./PanelHeader";

export function SshFormPanel({
  loading,
  onBack,
  onAdd,
}: {
  loading: boolean;
  onBack: () => void;
  onAdd: (connString: string) => void;
}) {
  const [connString, setConnString] = useState("");

  return (
    <>
      <PanelHeader onBack={onBack} title="Add SSH" />
      <div className="flex-1 flex flex-col gap-4 p-4">
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground font-medium">Connection string</label>
          <Input
            className="bg-muted dark:bg-muted"
            placeholder="user@host or user@host:port"
            value={connString}
            onChange={(e) => setConnString(e.target.value)}
          />
        </div>
      </div>
      <div className="p-4 border-t border-border shrink-0">
        <Button
          className="w-full"
          size="sm"
          disabled={!connString.trim() || loading}
          onClick={() => {
            onAdd(connString.trim());
            setConnString("");
          }}
        >
          {loading ? "Adding..." : "Add"}
        </Button>
      </div>
    </>
  );
}
