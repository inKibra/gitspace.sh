// Reviewed against each handler's behavior, not its RPC kind. Read-only means no caller-visible change;
// internal housekeeping (cache refresh, lease renewal, one-time migration) does not count. Anything that runs an
// agent turn or arbitrary code is destructive and open-world; reversible selections are not destructive. Open-world
// covers third parties (Git remotes, model and OAuth providers, external MCP, Composio), not GitSpace or Cloudflare.
export type ToolAnnotation =
  | { readOnlyHint: true; openWorldHint: boolean }
  | { readOnlyHint: false; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
export const reviewedAnnotations: Record<string, ToolAnnotation> = {
  "transcriptPage": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "transcriptContent": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "machines": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "machine.events": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "machine.updateNotes": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "machine.createSandbox": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": false,
    "openWorldHint": false
  },
  "machine.sleep": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "machine.resume": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": false,
    "openWorldHint": false
  },
  "machine.destroy": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "machine.image.list": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "machine.image.events": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "machine.image.set": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": true
  },
  "machine.image.retry": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": false,
    "openWorldHint": true
  },
  "machine.image.cancel": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": true
  },
  "machine.image.recover": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": true
  },
  "machine.image.defaults.get": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "machine.image.defaults.set": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": false,
    "openWorldHint": false
  },
  "devices.list": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "devices.revoke": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "deployment.status": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "deployment.launch": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": false,
    "openWorldHint": false
  },
  "deployment.revert": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": false,
    "openWorldHint": false
  },
  "placements": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "incidents.record": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "events": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "settings.get": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "settings.git.get": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "settings.update": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "settings.reserveHandle": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "settings.omp.get": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "settings.omp.set": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": false,
    "openWorldHint": false
  },
  "settings.events": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "inference.list": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "inference.create": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": false,
    "openWorldHint": false
  },
  "inference.update": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "inference.delete": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "inference.assign": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "inference.events": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "providers.list": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "providers.logout": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "providers.apiKey.set": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": false,
    "openWorldHint": false
  },
  "providers.usage": {
    "readOnlyHint": true,
    "openWorldHint": true
  },
  "providers.models": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "secrets.list": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "secrets.put": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": false,
    "openWorldHint": false
  },
  "secrets.delete": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "secrets.account.list": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "secrets.account.put": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": false,
    "openWorldHint": false
  },
  "secrets.account.delete": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "secrets.account.grant": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "secrets.account.revoke": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "configuration.values.get": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "configuration.values.put": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "configuration.values.delete": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "environment.events": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "environment.get": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "environment.putBundle": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "environment.setProfile": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "environment.putValue": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "environment.deleteValue": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "environment.approve": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "environment.revokeApproval": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "environment.runChecks": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": true
  },
  "environment.runPhase": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": true
  },
  "environment.cancelRun": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": true
  },
  "environment.recoverRun": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "environment.runLog": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "mcp.connections.list": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "mcp.connections.create": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": false,
    "openWorldHint": true
  },
  "mcp.connections.update": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": true
  },
  "mcp.connections.delete": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": true
  },
  "mcp.connections.status": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "mcp.composio.setup.get": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "mcp.composio.setup.put": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": true
  },
  "mcp.composio.setup.delete": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "mcp.composio.catalog": {
    "readOnlyHint": true,
    "openWorldHint": true
  },
  "mcp.composio.refresh": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": false,
    "openWorldHint": true
  },
  "mcp.composio.tools": {
    "readOnlyHint": true,
    "openWorldHint": true
  },
  "mcp.composio.updateTools": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": true
  },
  "mcp.composio.disconnect": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": true
  },
  "mcp.grants.list": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "mcp.grants.put": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "mcp.grants.delete": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "mcp.discover": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": false,
    "openWorldHint": true
  },
  "browserRelay.status": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "browserRelay.setup": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "browserRelay.start": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "browserRelay.stop": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "browserRelay.test": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "crons.list": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "crons.create": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": false,
    "openWorldHint": false
  },
  "crons.update": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "crons.delete": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "crons.runNow": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": false,
    "openWorldHint": true
  },
  "crons.history": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "skills.list": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "skills.update": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "project.events": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "project.directoryEvents": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "project.list": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "project.create": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": false,
    "openWorldHint": true
  },
  "project.ensureGitSpace": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "project.open": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": true
  },
  "project.archive": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "project.restore": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "project.setBaseBranch": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": true
  },
  "project.delete": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "space.events": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "space.close": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "space.reopen": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": true
  },
  "workspace.create": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": false,
    "openWorldHint": true
  },
  "workspace.retryCreate": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": true
  },
  "workspace.archive": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "workspace.restore": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": true
  },
  "workspace.delete": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "workspace.setPhase": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "workspace.setRelations": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "workspace.stackStatus": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "terminals.events": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "terminals.list": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "terminals.create": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": false,
    "openWorldHint": false
  },
  "terminals.read": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "terminals.send": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": false,
    "openWorldHint": true
  },
  "terminals.stop": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "inspector.artifacts.copyToProject": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "inspector.artifacts.list": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "inspector.artifacts.readPage": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "inspector.artifacts.shares.create": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": false,
    "openWorldHint": false
  },
  "inspector.artifacts.shares.list": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "inspector.artifacts.shares.revoke": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "inspector.artifacts.uploadAbort": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "inspector.artifacts.uploadBegin": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": false,
    "openWorldHint": false
  },
  "inspector.artifacts.uploadChunk": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "inspector.artifacts.uploadCommit": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "inspector.artifacts.write": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": false,
    "openWorldHint": false
  },
  "inspector.availability": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "inspector.goal.attachEvidence": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": false,
    "openWorldHint": false
  },
  "inspector.goal.put": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": false,
    "openWorldHint": false
  },
  "inspector.guide.analyze": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "inspector.guide.markSectionRead": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": false,
    "openWorldHint": false
  },
  "inspector.guide.put": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": false,
    "openWorldHint": false
  },
  "inspector.guide.setApproval": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": false,
    "openWorldHint": false
  },
  "inspector.guide.submit": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": false,
    "openWorldHint": false
  },
  "inspector.journal.append": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": false,
    "openWorldHint": false
  },
  "inspector.journal.endPhase": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": false,
    "openWorldHint": false
  },
  "inspector.journal.list": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "inspector.journal.startPhase": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": false,
    "openWorldHint": false
  },
  "inspector.overview": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "inspector.repository.diff": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "inspector.repository.file": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "inspector.repository.status": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "inspector.repository.treePage": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "inspector.resources.readPage": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "inspector.review.create": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": false,
    "openWorldHint": false
  },
  "inspector.review.list": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "inspector.review.reply": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": false,
    "openWorldHint": false
  },
  "inspector.review.resolve": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": false,
    "openWorldHint": false
  },
  "inspector.rubric.appendJudgment": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": false,
    "openWorldHint": false
  },
  "inspector.rubric.put": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": false,
    "openWorldHint": false
  },
  "inspector.services.list": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "inspector.services.start": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": false,
    "openWorldHint": true
  },
  "inspector.services.stop": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": false,
    "openWorldHint": true
  },
  "inspector.transcriptContent": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "inspector.transcriptPage": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "inspector.workflow.put": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": false,
    "openWorldHint": false
  },
  "inspector.workflow.waiveGate": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": false,
    "openWorldHint": false
  },
  "subagents.events": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "subagents.page": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "subagents.content": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "session.history": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "session.locate": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "session.create": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "session.createProject": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "session.prompt": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": false,
    "openWorldHint": true
  },
  "session.control": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "session.usage": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "session.agents": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "session.saveAgent": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "session.cycleRole": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": false,
    "openWorldHint": false
  },
  "session.setThinking": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "session.setApproval": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "session.setFast": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "session.setModel": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "session.setGoal": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": true
  },
  "session.compact": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": false,
    "openWorldHint": true
  },
  "session.navigateTree": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "session.clearQueue": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "session.removeQueuedMessage": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "session.promoteQueuedMessage": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": true
  },
  "session.answerAsk": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": false,
    "openWorldHint": true
  },
  "session.stop": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "space.view": {
    "readOnlyHint": true,
    "openWorldHint": false
  },
  "inspector.view": {
    "readOnlyHint": true,
    "openWorldHint": false
  }
};
