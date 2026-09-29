import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/alert-dialog";
import { Button } from "@/ui/button";
import { getFolderName } from "@/lib/path-utils";
import { useAnswerProjectTakeover } from "@/services/project.service";
import type { ConnectionKey } from "@/types/bindings";

/** Payload of `project-takeover-requested`, emitted by the Rust reader task. */
export interface TakeoverRequest {
  connection: ConnectionKey;
  request_id: string;
  project_path: string;
  requester_label: string;
}

/** The server gives the project away after this long without an answer. */
const ANSWER_SECONDS = 10;

/**
 * Another Maestro window asking for the project this one holds.
 *
 * The countdown only closes the dialog: the server enforces the timeout on its own, and counts
 * silence as giving the project up.
 */
export function ProjectTakeoverDialog() {
  const [request, setRequest] = useState<TakeoverRequest | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(ANSWER_SECONDS);
  const { mutate: answer } = useAnswerProjectTakeover();

  useEffect(() => {
    const unlisten = listen<TakeoverRequest>("project-takeover-requested", ({ payload }) => {
      setRequest(payload);
      setSecondsLeft(ANSWER_SECONDS);
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    if (!request) return;
    const tick = setInterval(() => setSecondsLeft((left) => left - 1), 1000);
    const close = setTimeout(() => setRequest(null), ANSWER_SECONDS * 1000);
    return () => {
      clearInterval(tick);
      clearTimeout(close);
    };
  }, [request]);

  const respond = (accept: boolean) => {
    if (!request) return;
    answer({ connection: request.connection, requestId: request.request_id, accept });
    setRequest(null);
  };

  return (
    <AlertDialog open={request !== null}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Give up this project?</AlertDialogTitle>
          <AlertDialogDescription>
            Maestro on {request?.requester_label} wants{" "}
            {request ? getFolderName(request.project_path) : ""}. Its agent sessions keep running.
            Given up in {secondsLeft}s if you do not answer.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => respond(false)}>
            Keep
          </Button>
          <AlertDialogAction onClick={() => respond(true)}>Give up</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
