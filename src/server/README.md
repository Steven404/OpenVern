# OpenVern API server: curl walkthrough

`createApp(core, { mode, version })` in `app.ts` is one Hono app. `dev.ts` hosts it on `127.0.0.1:8787` with
`@hono/node-server`; Electron's prod build calls the same `app.fetch` from `protocol.handle`.

Every `/api` request needs `X-OpenVern-Client: 1` and an allowed `Host` (`localhost` / `127.0.0.1` on any port,
or `openvern`). The server sends no CORS headers.

## Run the server with the fake provider

```sh
OPENVERN_FAKE_PROVIDER=1 OPENVERN_DATA_DIR=/tmp/openvern-demo npm run dev:server
```

## Scripted session: project, chat, streamed tool turn

Needs `curl` and `jq`. `PROJECT_DIR` must be a folder with a `README.md` (the fake model reads it).

```sh
API=http://127.0.0.1:8787/api
H='X-OpenVern-Client: 1'
PROJECT_DIR=${PROJECT_DIR:-$PWD}          # any folder with a README.md (the repo root works)

curl -s -H "$H" $API/health

# Without the header the request is refused (403)
curl -s -o /dev/null -w '%{http_code}\n' $API/health

# 1. Add a project
PROJECT=$(curl -s -H "$H" -H 'Content-Type: application/json' \
  -d "{\"rootPath\":\"$PROJECT_DIR\"}" $API/projects)
echo "$PROJECT"
PROJECT_ID=$(echo "$PROJECT" | jq -r .id)

# 2. Create a chat attached to it
CHAT_ID=$(curl -s -H "$H" -H 'Content-Type: application/json' \
  -d "{\"projectId\":\"$PROJECT_ID\",\"model\":\"anthropic/claude-sonnet-5.5\"}" $API/chats | jq -r .id)

# 3. Stream a turn (-N: no buffering). The fake model reads README.md with the read_file tool.
curl -sN -H "$H" -H 'Content-Type: application/json' \
  -d '{"text":"What does the README say?","attachmentIds":[],"model":"anthropic/claude-sonnet-5.5"}' \
  $API/chats/$CHAT_ID/messages

# 4. The persisted chat
curl -s -H "$H" $API/chats/$CHAT_ID | jq '{title, messages: [.messages[] | {role, status, text: (.text // .summary)}]}'

# 5. Errors are JSON bodies with a status (a concurrent second run is 409; a missing chat is 404)
curl -s -H "$H" $API/chats/nope
```

Stop the stream early with Ctrl+C (or `curl --max-time 0.2`): the run is aborted and the partial reply is saved
with `status: "stopped"`.

## Terminal reads

The model reads a chat's terminal through the `read_terminal` tool, and only a client that can answer does so. Such a
client sends `"terminal": true` in the body of `POST /api/chats/:id/messages` or `POST /api/chats/:id/retry`. The turn
then offers the tool, if the model supports tools. When the model calls it, the stream sends a `terminal_read_request`
event, and the client answers with `POST /api/chats/:id/terminal-reads/:requestId`, whose body is either
`{"ok": true, "result": {...}}` or `{"ok": false, "reason": "no_terminal" | "unavailable"}`.

- `204`: a waiting read took the answer.
- `404`: unknown, expired, already answered, or for another chat.
- `400`: a malformed body. Unknown properties are refused.
- `413`: the body is above 8 MiB.

A client that sends `"terminal": true` and never answers makes the read fail after 10 seconds.
