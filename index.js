// access-prompt — a tiny, dependency-free cross-platform "access request"
// dialog. It shows a native modal with three choices plus a timeout and maps
// every outcome to one stable decision string, so callers never have to parse
// per-OS exit codes.
//
//   promptAccess({ agentName, serverName, timeoutSeconds }) -> Promise<{
//     decision: "allow" | "allow_session" | "deny" | "no_response" | "unavailable",
//     reason:   string | null,   // human/agent-readable explanation
//     tool:     string | null    // which backend was used
//   }>
//
// Backends, in preference order:
//   Linux:   kdialog (KDE-native, preferred) -> zenity (GTK)
//   macOS:   osascript (AppleScript display dialog)
//   Windows: powershell (a small WinForms form)
// If none is available, the result is { decision: "unavailable", ... } carrying
// a message that tells the agent/user exactly what to install — it is never a
// silent failure and never a false "deny".

const { execFile } = require("child_process");
const { execFileSync } = require("child_process");

const SESSION_LABEL = "✅ Allow this session"; // "✅ Allow this session"

function hasCommand(cmd) {
  try {
    const probe = process.platform === "win32" ? "where" : "which";
    execFileSync(probe, [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Spawn a backend, enforce a JS-side timeout (so we don't depend on each tool's
// own timeout flag), and hand the raw result to a mapper.
function runBackend(cmd, args, timeoutSeconds, map) {
  return new Promise((resolve) => {
    let timedOut = false;
    const child = execFile(cmd, args, { windowsHide: true, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      clearTimeout(timer);
      const code = error && typeof error.code === "number" ? error.code : (error ? -1 : 0);
      resolve(map({
        timedOut,
        code,
        stdout: (stdout || "").toString(),
        stderr: (stderr || "").toString(),
        spawnError: error && error.code === "ENOENT" ? error : null
      }));
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch {}
    }, Math.max(1, timeoutSeconds) * 1000);
  });
}

function bodyText(agentName, serverName) {
  return [
    "An agent is requesting an SSH connection.",
    "",
    `Agent:    ${agentName}`,
    `Machine:  ${serverName}`,
    "",
    "Allow — permit this one connection",
    "Allow this session — stop asking for this machine until this computer restarts",
    "Deny — refuse the connection"
  ].join("\n");
}

// ---- Linux: kdialog (preferred) ------------------------------------------
function promptKdialog(agentName, serverName, timeoutSeconds) {
  const html = bodyText(agentName, serverName)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/^(Agent:|Machine:|Allow|Allow this session|Deny|An agent[^\n]*)/gm, "<b>$1</b>")
    .replace(/\n/g, "<br/>");
  const args = [
    "--title", "Termius · SSH Access Request",
    "--yesnocancel", html,
    "--yes-label", "Allow",
    "--no-label", SESSION_LABEL,
    "--cancel-label", "Deny"
  ];
  return runBackend("kdialog", args, timeoutSeconds, (r) => {
    if (r.timedOut) return { decision: "no_response", tool: "kdialog" };
    if (r.code === 0) return { decision: "allow", tool: "kdialog" };
    if (r.code === 1) return { decision: "allow_session", tool: "kdialog" };
    if (r.code === 2) return { decision: "deny", tool: "kdialog" };
    return { decision: "unavailable", tool: "kdialog", reason: `kdialog failed (code ${r.code}): ${r.stderr.trim()}` };
  });
}

// ---- Linux: zenity (fallback) --------------------------------------------
function promptZenity(agentName, serverName, timeoutSeconds) {
  const text = bodyText(agentName, serverName)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/^(Agent:|Machine:|Allow|Allow this session|Deny)/gm, "<b>$1</b>");
  const args = [
    "--question", "--width=460",
    "--title", "Termius · SSH Access Request",
    "--text", text,
    "--ok-label", "Allow",
    "--cancel-label", "Deny",
    "--extra-button", SESSION_LABEL
  ];
  return runBackend("zenity", args, timeoutSeconds, (r) => {
    if (r.timedOut) return { decision: "no_response", tool: "zenity" };
    if (r.code === 0) return { decision: "allow", tool: "zenity" };
    if (r.stdout.trim() === SESSION_LABEL) return { decision: "allow_session", tool: "zenity" };
    if (r.code === 1) return { decision: "deny", tool: "zenity" };
    return { decision: "unavailable", tool: "zenity", reason: `zenity failed (code ${r.code}): ${r.stderr.trim()}` };
  });
}

// ---- macOS: osascript ----------------------------------------------------
function promptOsascript(agentName, serverName, timeoutSeconds) {
  const msg = bodyText(agentName, serverName).replace(/"/g, '\\"');
  // No "Cancel"-named button, so every click returns via stdout (a Cancel
  // button would make osascript throw "User canceled"). `giving up after`
  // yields `gave up:true` on timeout.
  const script =
    `display dialog "${msg}" with title "Termius - SSH Access Request" ` +
    `buttons {"Deny", "${SESSION_LABEL}", "Allow"} default button "Allow" ` +
    `giving up after ${Math.max(1, timeoutSeconds)}`;
  return runBackend("osascript", ["-e", script], timeoutSeconds + 5, (r) => {
    if (r.timedOut) return { decision: "no_response", tool: "osascript" };
    const out = r.stdout;
    if (/gave up:true/.test(out)) return { decision: "no_response", tool: "osascript" };
    if (/button returned:Allow this session/.test(out) || out.includes(SESSION_LABEL)) return { decision: "allow_session", tool: "osascript" };
    if (/button returned:Allow/.test(out)) return { decision: "allow", tool: "osascript" };
    if (/button returned:Deny/.test(out)) return { decision: "deny", tool: "osascript" };
    if (r.code !== 0) return { decision: "unavailable", tool: "osascript", reason: `osascript failed (code ${r.code}): ${r.stderr.trim()}` };
    return { decision: "deny", tool: "osascript" };
  });
}

// ---- Windows: PowerShell WinForms ----------------------------------------
function promptPowershell(agentName, serverName, timeoutSeconds) {
  const esc = (s) => String(s).replace(/'/g, "''");
  const lines = bodyText(agentName, serverName).split("\n").map(esc).join("`r`n");
  // A 3-button form with a timer; prints ALLOW / SESSION / DENY / TIMEOUT.
  const ps = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$f=New-Object System.Windows.Forms.Form
$f.Text='Termius - SSH Access Request'
$f.Width=520; $f.Height=250; $f.StartPosition='CenterScreen'; $f.TopMost=$true
$l=New-Object System.Windows.Forms.Label
$l.Text='${lines}'
$l.AutoSize=$false; $l.Width=490; $l.Height=140; $l.Left=12; $l.Top=10
$f.Controls.Add($l)
$script:R='DENY'
$ba=New-Object System.Windows.Forms.Button; $ba.Text='Allow'; $ba.Left=250; $ba.Top=170; $ba.Width=110
$ba.Add_Click({ $script:R='ALLOW'; $f.Close() })
$bs=New-Object System.Windows.Forms.Button; $bs.Text='Allow this session'; $bs.Left=120; $bs.Top=170; $bs.Width=120
$bs.Add_Click({ $script:R='SESSION'; $f.Close() })
$bd=New-Object System.Windows.Forms.Button; $bd.Text='Deny'; $bd.Left=30; $bd.Top=170; $bd.Width=80
$bd.Add_Click({ $script:R='DENY'; $f.Close() })
$f.Controls.AddRange(@($ba,$bs,$bd))
$t=New-Object System.Windows.Forms.Timer
$t.Interval=${Math.max(1, timeoutSeconds)}*1000
$t.Add_Tick({ $script:R='TIMEOUT'; $t.Stop(); $f.Close() })
$t.Start()
[void]$f.ShowDialog()
Write-Output $script:R
`.trim();
  return runBackend("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], timeoutSeconds + 5, (r) => {
    if (r.timedOut) return { decision: "no_response", tool: "powershell" };
    const out = r.stdout.trim().toUpperCase();
    if (out.includes("ALLOW") && !out.includes("SESSION")) return { decision: "allow", tool: "powershell" };
    if (out.includes("SESSION")) return { decision: "allow_session", tool: "powershell" };
    if (out.includes("TIMEOUT")) return { decision: "no_response", tool: "powershell" };
    if (out.includes("DENY")) return { decision: "deny", tool: "powershell" };
    return { decision: "unavailable", tool: "powershell", reason: `powershell failed (code ${r.code}): ${r.stderr.trim()}` };
  });
}

function unavailable() {
  const hint = process.platform === "linux"
    ? "Install a dialog tool: `kdialog` (KDE) or `zenity` (GNOME)."
    : process.platform === "darwin"
      ? "osascript is missing (it ships with macOS)."
      : process.platform === "win32"
        ? "PowerShell is required (it ships with Windows)."
        : `Unsupported platform "${process.platform}".`;
  return Promise.resolve({
    decision: "unavailable",
    tool: null,
    reason: `No GUI dialog backend is available on this host, so the connection cannot be authorized interactively. ${hint}`
  });
}

async function promptAccess({ agentName, serverName, timeoutSeconds = 120 } = {}) {
  const agent = agentName || "an agent";
  const server = serverName || "the machine";
  let res;
  if (process.platform === "linux") {
    if (hasCommand("kdialog")) res = await promptKdialog(agent, server, timeoutSeconds);
    else if (hasCommand("zenity")) res = await promptZenity(agent, server, timeoutSeconds);
    else return unavailable();
  } else if (process.platform === "darwin") {
    if (hasCommand("osascript")) res = await promptOsascript(agent, server, timeoutSeconds);
    else return unavailable();
  } else if (process.platform === "win32") {
    if (hasCommand("powershell")) res = await promptPowershell(agent, server, timeoutSeconds);
    else return unavailable();
  } else {
    return unavailable();
  }
  // A backend that errored out (e.g. no display) → treat as unavailable, not deny.
  if (res.decision === "unavailable" && !res.reason) res.reason = "The dialog backend exited abnormally.";
  if (!("reason" in res)) res.reason = null;
  return res;
}

module.exports = { promptAccess, SESSION_LABEL };
