# @c0dingbear/access-prompt

A tiny, dependency-free cross-platform **access-request dialog** for Node.js.
Shows a native modal asking the user to approve something, and maps every
outcome — including "no choice" and "allow for this session" — to one stable
decision string, so you never parse per-OS exit codes.

## Backends

| OS | Tool (in preference order) |
|----|----------------------------|
| Linux | `kdialog` (KDE) → `zenity` (GNOME) |
| macOS | `osascript` |
| Windows | `powershell` (WinForms) |

If none is available the call resolves to `decision: "unavailable"` with an
explanation — never a silent failure and never a false `deny`.

## Usage

```js
const { promptAccess } = require("@c0dingbear/access-prompt");

const res = await promptAccess({
  agentName: "My-Agent",
  serverName: "prod-db-01",
  timeoutSeconds: 120
});

// res.decision:
//   "allow"         - approved this one time
//   "allow_session" - approved until the dialog is asked to stop (your app decides scope)
//   "deny"          - explicitly refused
//   "no_response"   - timed out; the user made no choice (not a denial)
//   "unavailable"   - no dialog backend on this host (res.reason explains)
// res.reason: string | null   res.tool: which backend was used
```

The three choices shown are **Allow**, **✅ Allow this session**, and **Deny**.
The library only returns the decision; what "session" means (e.g. minting a
token) is up to the caller.

## License

MIT
