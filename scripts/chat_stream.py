#!/usr/bin/env python3
"""Sends one chat turn and prints one JSON object per line: each SSE event plus
the seconds since the request was sent ("t"), as it arrives. Used by
verify-phase5.sh to prove tool calls are streamed (not delivered at the end)
and to inspect which tools the agent called.

  chat_stream.py URL "message" [--bearer KEY | --cookie JAR --origin ORIGIN] [--approve]

A write tool makes the gateway stop with a "confirm" event and wait for the user.
With --approve this script plays the user: it approves what was held and sends
the follow-up turn, printing that turn's events too (a "confirm" is printed first).
"""
import http.cookiejar
import json
import sys
import time
import urllib.error
import urllib.request

url, message, *rest = sys.argv[1:]
headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
if "--bearer" in rest:
    headers["Authorization"] = "Bearer " + rest[rest.index("--bearer") + 1]
if "--cookie" in rest:
    jar = http.cookiejar.MozillaCookieJar(rest[rest.index("--cookie") + 1])
    jar.load(ignore_discard=True, ignore_expires=True)
    headers["Cookie"] = "; ".join(f"{c.name}={c.value}" for c in jar)
    headers["Origin"] = rest[rest.index("--origin") + 1]

start = time.time()


def turn(messages, approved):
    body = {"messages": messages}
    if approved:
        body["approved"] = approved
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        resp = urllib.request.urlopen(req, timeout=150)
    except urllib.error.HTTPError as e:
        print(json.dumps({"http_status": e.code, "body": e.read().decode()[:300]}))
        sys.exit(0)
    held = []
    for raw in resp:  # unbuffered line iteration: yields as soon as a line arrives
        line = raw.decode().rstrip("\n")
        if line.startswith("data: "):
            data = json.loads(line[6:])
            data["t"] = round(time.time() - start, 2)
            print(json.dumps(data), flush=True)
            if data.get("type") == "confirm":
                held.append({"name": data["name"], "args": data["args"]})
    return held


messages = [{"role": "user", "text": message}]
held = turn(messages, None)
for _ in range(3):  # a turn may hold several writes in a row
    if not (held and "--approve" in rest):
        break
    what = "; ".join(f"{h['name']} with {json.dumps(h['args'])}" for h in held)
    messages = messages + [{"role": "user", "text": f"Yes, go ahead: {what}."}]
    held = turn(messages, held)
