#!/usr/bin/env python3
"""Sends one chat turn and prints one JSON object per line: each SSE event plus
the seconds since the request was sent ("t"), as it arrives. Used by
verify-phase5.sh to prove tool calls are streamed (not delivered at the end)
and to inspect which tools the agent called.

  chat_stream.py URL "message" [--bearer KEY | --cookie JAR --origin ORIGIN]
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

req = urllib.request.Request(
    url,
    data=json.dumps({"messages": [{"role": "user", "text": message}]}).encode(),
    headers=headers,
    method="POST",
)
start = time.time()
try:
    resp = urllib.request.urlopen(req, timeout=150)
except urllib.error.HTTPError as e:
    print(json.dumps({"http_status": e.code, "body": e.read().decode()[:300]}))
    sys.exit(0)

event = None
for raw in resp:  # unbuffered line iteration: yields as soon as a line arrives
    line = raw.decode().rstrip("\n")
    if line.startswith("data: "):
        data = json.loads(line[6:])
        data["t"] = round(time.time() - start, 2)
        print(json.dumps(data), flush=True)
