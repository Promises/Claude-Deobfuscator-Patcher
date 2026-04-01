important files


┌─────────────────────┬─────────────────────────┬──────────────────────────────────────────────────────────────────────────────┐
│        File         │          Hook           │                                   Purpose                                    │
├─────────────────────┼─────────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
│ _preamble.js        │ Sidecar module          │ The full WebSocket client (Phoenix V2 protocol, auto-connect, mirror, queue) │
│                     │ injection               │                                                                              │
├─────────────────────┼─────────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
│ bootstrap/state.js  │ v_() session ID         │ Triggers autoConnect() on first call — creates session + joins channel       │
│                     │ function                │                                                                              │
├─────────────────────┼─────────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
│ cli/structuredIO.js │ prependUserMessage()    │ Captures the StructuredIO instance so remote input/permissions can be        │
│                     │                         │ injected                                                                     │
├─────────────────────┼─────────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
│ query.js            │ Pb() query wrapper      │ Wraps the yield loop to mirrorMessage() every message from the API           │
└─────────────────────┴─────────────────────────┴──────────────────────────────────────────────────────────────────────────────┘
