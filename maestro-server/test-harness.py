#!/usr/bin/env python3
"""
Test harness for maestro-server.
Spawns the server, sends length-prefixed JSON messages, reads responses.

Usage:
  python3 test-harness.py [path-to-maestro-server-binary]
"""

import subprocess
import struct
import json
import sys
import threading
import os

BINARY = sys.argv[1] if len(sys.argv) > 1 else "./target/release/maestro-server"

def write_msg(proc, msg: dict):
    body = json.dumps(msg).encode("utf-8")
    header = struct.pack("<I", len(body))
    proc.stdin.write(header + body)
    proc.stdin.flush()

def read_msg(proc) -> dict:
    header = proc.stdout.read(4)
    if len(header) < 4:
        raise EOFError("Server closed stdout")
    (length,) = struct.unpack("<I", header)
    body = proc.stdout.read(length)
    return json.loads(body)

def reader_thread(proc):
    try:
        while True:
            msg = read_msg(proc)
            direction = msg.get("direction", "?")
            msg_type = msg.get("type", "?")
            print(f"\n<<< [{direction}/{msg_type}] {json.dumps(msg, indent=2)}")
            if msg_type == "permission_request":
                rid = msg.get("request_id", "")
                print(f"\n*** PERMISSION REQUESTED ***")
                print(f"    request_id: {rid}")
                print(f"    To allow:   permit {rid}")
                print(f"    To deny:    deny {rid}")
            print(">>> ", end="", flush=True)
    except (EOFError, Exception) as e:
        print(f"\n[reader] stopped: {e}")

def main():
    session_id = "test-sess-1"
    cwd = os.getcwd()

    print(f"Spawning: {BINARY}")
    proc = subprocess.Popen(
        [BINARY],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=None,
    )

    t = threading.Thread(target=reader_thread, args=(proc,), daemon=True)
    t.start()

    print(f"""
Commands:
  list                      — ListAgentsRequest
  spawn [agent_id] [cwd]   — SpawnRequest (default: claude-acp, {cwd})
  prompt <text>             — PromptRequest
  permit <request_id>       — PermitResponse allowed=true
  deny <request_id>         — PermitResponse allowed=false
  cancel                    — CancelRequest
  quit                      — Exit
""")

    while True:
        try:
            line = input(">>> ").strip()
        except (EOFError, KeyboardInterrupt):
            break

        if not line:
            continue

        parts = line.split(maxsplit=2)
        cmd = parts[0].lower()

        if cmd == "list":
            write_msg(proc, {
                "direction": "request",
                "type": "list_agents",
            })

        elif cmd == "spawn":
            agent_id = parts[1] if len(parts) > 1 else "claude-acp"
            spawn_cwd = parts[2] if len(parts) > 2 else cwd
            write_msg(proc, {
                "direction": "request",
                "type": "spawn",
                "agent_id": agent_id,
                "session_id": session_id,
                "cwd": spawn_cwd,
            })

        elif cmd == "prompt":
            content = line[len("prompt "):].strip()
            write_msg(proc, {
                "direction": "request",
                "type": "prompt",
                "session_id": session_id,
                "content": content,
            })

        elif cmd == "permit":
            rid = parts[1] if len(parts) > 1 else ""
            write_msg(proc, {
                "direction": "request",
                "type": "permit_response",
                "session_id": session_id,
                "request_id": rid,
                "allowed": True,
            })

        elif cmd == "deny":
            rid = parts[1] if len(parts) > 1 else ""
            write_msg(proc, {
                "direction": "request",
                "type": "permit_response",
                "session_id": session_id,
                "request_id": rid,
                "allowed": False,
            })

        elif cmd == "cancel":
            write_msg(proc, {
                "direction": "request",
                "type": "cancel",
                "session_id": session_id,
            })

        elif cmd == "quit":
            break

        else:
            print(f"Unknown: {cmd}")

    proc.terminate()
    proc.wait()
    print("Done.")

if __name__ == "__main__":
    main()
