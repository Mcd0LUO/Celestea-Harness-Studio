// i18n/locales/en/mcp.ts — W-C2: the settings "MCP" pane (read-only status surface).
//
// Key set is identical to zh by construction (the zh dictionary defines the Key
// union), so a missing translation here is a COMPILE error, not a runtime blank.
//
// Protocol names (stdio / http), server names and failure-kind enums are NOT
// translated: they are decision inputs, not prose (docs/feature/mcp-client.md
// §6.3 — never branch on wording, on either side of the wire).
export const mcp = {
  'settings.mcp.tab': 'MCP',
  'settings.mcp.paneTitle': 'MCP servers',
  'settings.mcp.paneNote': 'Read-only status: connection state and tool counts. Configured in mcp.json; this pane does not edit it.',
  'settings.mcp.summary': '{servers} servers · {tools} tools · {sessions} session instances',
  'settings.mcp.empty': 'No enabled MCP server yet.',
  'settings.mcp.emptyHint': 'Drop an mcp.json in the data directory: global <CELESTEA_HOME>/mcp.json, workspace <CELESTEA_HOME>/workspaces/<ws>/mcp.json. Changes take effect at the next session generation.',
  'settings.mcp.unavailable': 'This pane cannot read a status: the service returned no MCP status.',
  'settings.mcp.configError': 'Config unreadable: {message}',
  'settings.mcp.tools': '{n} tools',
  'settings.mcp.session': 'session {id}',
  'settings.mcp.transport': 'transport {value}',
  'settings.mcp.failure': 'Failure kind: {kind}',
  'settings.mcp.issuesTitle': 'Config issues',
  'settings.mcp.issueLine': '{kind} · {message}',
  'settings.mcp.issueServer': '{server}: {kind} · {message}',
  'settings.mcp.state.idle': 'Not connected',
  'settings.mcp.state.connecting': 'Connecting',
  'settings.mcp.state.ready': 'Ready',
  'settings.mcp.state.backoff': 'Retrying (backoff)',
  'settings.mcp.state.failed': 'Failed',
  'settings.mcp.state.disposed': 'Released',
  'settings.mcp.state.disabled': 'Disabled',
  'settings.mcp.state.unknown': 'Unknown state',
  'settings.mcp.failure.connect_failed': 'cannot connect',
  'settings.mcp.failure.protocol_incompatible': 'protocol incompatible',
  'settings.mcp.failure.unauthorized': 'rejected by auth',
  'settings.mcp.failure.timeout': 'timed out',
  'settings.mcp.failure.server_error': 'server-side error',
  'settings.mcp.failure.schema_unsupported': 'unsupported parameter schema',
  'settings.mcp.failure.not_ready': 'not ready yet',
  'settings.mcp.failure.call_failed': 'call failed',
  'settings.mcp.failure.disposed': 'connection released',
  'settings.mcp.failure.unknown': 'unknown kind',
} as const;
