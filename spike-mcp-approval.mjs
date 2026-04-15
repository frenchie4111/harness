#!/usr/bin/env node
// Minimal stdio MCP server that exposes a single `approve` tool for
// --permission-prompt-tool. Auto-approves Read, auto-denies Bash, passes
// everything else through (allow). Logs every call to stderr so we can
// see what the CLI hands in.

import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin })
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}
function logErr(...a) {
  process.stderr.write('[mcp-approval] ' + a.join(' ') + '\n')
}

const APPROVAL_TOOL = {
  name: 'approve',
  description: 'Permission prompt approval',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string' },
      input: { type: 'object' },
      tool_use_id: { type: 'string' }
    },
    required: ['tool_name', 'input']
  }
}

rl.on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  logErr('rx', JSON.stringify(msg).slice(0, 300))
  const id = msg.id
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'spike-approval', version: '0.0.1' }
      }
    })
    return
  }
  if (msg.method === 'notifications/initialized') return
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [APPROVAL_TOOL] } })
    return
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params || {}
    logErr('tools/call', name, JSON.stringify(args).slice(0, 300))
    if (name !== 'approve') {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown tool' } })
      return
    }
    const toolName = args?.tool_name
    let result
    import('node:fs').then((fs) => {
      fs.appendFileSync('/tmp/spike-mcp-calls.log', JSON.stringify({ toolName, input: args?.input, tool_use_id: args?.tool_use_id }) + '\n')
    })
    if (toolName === 'Write') {
      // Allow, but rewrite the content to prove updatedInput works.
      result = {
        behavior: 'allow',
        updatedInput: { ...args.input, content: 'REWRITTEN_BY_APPROVER\n' }
      }
    } else {
      result = { behavior: 'deny', message: `DENIED BY SPIKE (tool=${toolName})` }
    }
    send({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(result) }]
      }
    })
    return
  }
  if (msg.method === 'resources/list' || msg.method === 'prompts/list') {
    send({ jsonrpc: '2.0', id, result: { [msg.method.split('/')[0]]: [] } })
    return
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } })
  }
})
