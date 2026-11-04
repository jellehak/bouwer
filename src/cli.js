#!/usr/bin/env node

import { exec, execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import readline from 'node:readline/promises'
import process, { loadEnvFile } from 'node:process'

try {
  loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)
let workingDirectory = process.cwd()
const host = (process.env.LLM_SERVER || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '')
const chatEndpoint = host.endsWith('/api') ? `${host}/chat` : `${host}/api/chat`
const model = process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b'
const numCtx = positiveInteger(process.env.OLLAMA_NUM_CTX, 4096)
const maxToolCalls = 8
const maxOutput = 64 * 1024
const historyLimit = numCtx * 2
const history = []
let summary = ''

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

const architectPrompt = `You are the architect in a small coding assistant.
Make a concise plan for the worker based on the user's request. Use the supplied project summary if present.
Do not execute tools or write the solution. Keep the plan to at most 5 short steps.`

const workerPrompt = `You are a practical coding assistant working in the current project directory.
Follow the architect's plan and complete the user's request. Be concise and use tools only when needed.
You may execute Node.js code or terminal commands using the available tools. Never claim a command ran unless its output confirms it.
Terminal commands require user approval. Work in small, verifiable steps and report what changed.`

const tools = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command in the current project directory. Requires user approval.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run' },
          timeout_ms: { type: 'integer', description: 'Timeout in milliseconds, maximum 120000' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_node',
      description: 'Execute JavaScript source with the current Node.js runtime. Requires user approval.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'JavaScript source code to execute' },
          timeout_ms: { type: 'integer', description: 'Timeout in milliseconds, maximum 120000' }
        },
        required: ['code']
      }
    }
  }
]

function positiveInteger (value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function parseCliOptions (args) {
  let workspace
  let help = false
  let workspaceSet = false

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') {
      help = true
    } else if (arg === '--workspace') {
      if (workspaceSet) throw new Error('Use --workspace only once.')
      workspaceSet = true
      const next = args[index + 1]
      if (next && !next.startsWith('--')) {
        workspace = next
        index++
      }
    } else if (arg.startsWith('--workspace=')) {
      if (workspaceSet) throw new Error('Use --workspace only once.')
      workspaceSet = true
      workspace = arg.slice('--workspace='.length)
    } else {
      throw new Error(`Unknown option: ${arg}. Use --help for usage.`)
    }
  }

  return { help, workspace: workspaceSet ? (workspace || null) : undefined }
}

async function createWorkspace (name) {
  const workspaceRoot = join(process.cwd(), 'workspace')
  await mkdir(workspaceRoot, { recursive: true })

  if (name !== null) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || name === '.' || name === '..') {
      throw new Error('Workspace name must be 1-64 letters, numbers, dots, underscores or hyphens, and start with a letter or number.')
    }
    const directory = join(workspaceRoot, name)
    await mkdir(directory)
    return directory
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (let suffix = 0; ; suffix++) {
    const directory = join(workspaceRoot, suffix ? `${timestamp}-${suffix}` : timestamp)
    try {
      await mkdir(directory)
      return directory
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
}

function shorten (text) {
  return text.length > maxOutput ? `${text.slice(0, maxOutput)}\n[output truncated]` : text
}

async function withStatus (label, operation) {
  const started = Date.now()
  let frame = 0
  let lastReported = started
  const tty = process.stderr.isTTY
  const render = () => {
    const elapsed = Math.floor((Date.now() - started) / 1000)
    if (tty) {
      const frames = ['|', '/', '-', '\\']
      process.stderr.write(`\r${frames[frame++ % frames.length]} ${label} (${elapsed}s)`)
    } else if (Date.now() - lastReported >= 5000) {
      process.stderr.write(`... ${label} (${elapsed}s)\n`)
      lastReported = Date.now()
    }
  }

  process.stderr.write(`... ${label}\n`)
  const timer = setInterval(render, tty ? 100 : 1000)
  timer.unref()

  try {
    const result = await operation()
    clearInterval(timer)
    const elapsed = ((Date.now() - started) / 1000).toFixed(1)
    if (tty) process.stderr.write(`\r\x1b[2K`)
    process.stderr.write(`✓ ${label} (${elapsed}s)\n`)
    return result
  } catch (error) {
    clearInterval(timer)
    const elapsed = ((Date.now() - started) / 1000).toFixed(1)
    if (tty) process.stderr.write(`\r\x1b[2K`)
    process.stderr.write(`✗ ${label} (${elapsed}s)\n`)
    throw error
  }
}

async function askApproval (command) {
  const answer = await rl.question(`\nRun this command? [y/N]\n${command}\n> `)
  return answer.trim().toLowerCase() === 'y'
}

async function runTool (name, args) {
  if (name !== 'run_command' && name !== 'run_node') {
    return `Unknown tool: ${name}`
  }

  const value = name === 'run_command' ? args.command : args.code
  if (typeof value !== 'string' || value.length === 0) {
    return `Invalid ${name} input: expected a non-empty ${name === 'run_command' ? 'command' : 'code'} string.`
  }

  const timeout = Math.min(positiveInteger(args.timeout_ms, 30000), 120000)
  const approved = await askApproval(name === 'run_command' ? value : `node -e '<provided JavaScript>'`)
  if (!approved) return 'Command not run: user declined approval.'

  return withStatus(name === 'run_command' ? 'Terminalcommando uitvoeren' : 'Node.js-script uitvoeren', async () => {
    try {
      const options = { timeout, maxBuffer: 1024 * 1024, cwd: workingDirectory }
      const result = name === 'run_command'
        ? await execAsync(value, options)
        : await execFileAsync(process.execPath, ['--input-type=module', '-e', value], options)
      return shorten([result.stdout, result.stderr].filter(Boolean).join('\n') || '(no output)')
    } catch (error) {
      const output = [error.stdout, error.stderr].filter(Boolean).join('\n')
      return shorten(`Command failed${error.code ? ` (${error.code})` : ''}:\n${output || error.message}`)
    }
  })
}

async function chat (messages, withTools = false, status = 'Model denkt na') {
  return withStatus(status, async () => {
    const response = await fetch(chatEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        ...(withTools ? { tools } : {}),
        options: { num_ctx: numCtx, temperature: 0.2 }
      }),
      signal: AbortSignal.timeout(180000)
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Ollama returned ${response.status}: ${body}`)
    }

    const data = await response.json()
    if (!data.message) throw new Error('Ollama response did not contain a message.')
    return data.message
  })
}

async function summarizeHistory () {
  if (history.length < 2) return

  const messages = [
    {
      role: 'system',
      content: 'Summarize this coding-assistant conversation in under 180 words. Preserve user goals, decisions, project facts, and unfinished work. Omit chatter.'
    },
    ...(summary ? [{ role: 'user', content: `Previous summary:\n${summary}` }] : []),
    ...history
  ]
  const result = await chat(messages, false, 'Gesprek samenvatten')
  summary = result.content?.trim() || summary
  history.length = 0
}

async function handleTurn (request) {
  const historySize = history.reduce((total, message) => total + message.content.length, 0)
  if (historySize > historyLimit) await summarizeHistory()

  const architectMessages = [
    { role: 'system', content: architectPrompt },
    ...(summary ? [{ role: 'user', content: `Project conversation summary:\n${summary}` }] : []),
    { role: 'user', content: request }
  ]
  const plan = (await chat(architectMessages, false, 'Architect maakt plan')).content?.trim()
  if (!plan) throw new Error('The architect returned an empty plan.')

  const messages = [
    { role: 'system', content: workerPrompt },
    ...(summary ? [{ role: 'system', content: `Conversation summary:\n${summary}` }] : []),
    ...history.slice(-6),
    { role: 'user', content: `Architect's plan:\n${plan}\n\nUser request:\n${request}` }
  ]

  for (let call = 0; call < maxToolCalls; call++) {
    const response = await chat(messages, true, `Worker werkt (stap ${call + 1})`)
    messages.push(response)
    const calls = response.tool_calls || []
    if (calls.length === 0) {
      const answer = response.content?.trim()
      if (!answer) throw new Error('The worker returned an empty response.')
      console.log(`\n${answer}\n`)
      history.push({ role: 'user', content: request }, { role: 'assistant', content: answer })
      return
    }

    for (const toolCall of calls) {
      const name = toolCall.function?.name
      let args
      try {
        args = typeof toolCall.function?.arguments === 'string'
          ? JSON.parse(toolCall.function.arguments)
          : toolCall.function?.arguments
      } catch {
        args = null
      }
      const output = args && typeof args === 'object'
        ? await runTool(name, args)
        : 'Invalid tool arguments: expected a JSON object.'
      messages.push({
        role: 'tool',
        tool_name: name,
        content: output
      })
    }
  }

  throw new Error(`Stopped after ${maxToolCalls} tool rounds. Send a follow-up to continue.`)
}

function printHelp () {
  console.log(`
Bouwer - a low-context coding assistant for Ollama

Usage:
  bouwer [--workspace [name]]

Options:
  --workspace [name]  Create and use workspace/<name>; omit name to generate one
  -h, --help          Show this help

Commands:
  :help   Show this help
  :clear  Clear conversation history and its summary
  :exit   Quit

Environment:
  LLM_SERVER       Ollama server URL (default: http://127.0.0.1:11434)
  OLLAMA_HOST      Legacy alias for LLM_SERVER
  OLLAMA_MODEL     Model name (default: qwen2.5-coder:7b)
  OLLAMA_NUM_CTX   Context size (default: 4096)
`)
}

async function main () {
  const options = parseCliOptions(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }

  if (options.workspace !== undefined) {
    workingDirectory = await createWorkspace(options.workspace)
    console.log(`Workspace aangemaakt: ${workingDirectory}`)
  }

  console.log(`Bouwer | ${model} | context ${numCtx} | ${workingDirectory}`)
  console.log('Type :help for commands. Tool execution asks for approval.')

  try {
    while (true) {
      const request = (await rl.question('\n> ')).trim()
      if (!request) continue
      if (request === ':exit') break
      if (request === ':help') {
        printHelp()
        continue
      }
      if (request === ':clear') {
        history.length = 0
        summary = ''
        console.log('Conversation cleared.')
        continue
      }

      try {
        await handleTurn(request)
      } catch (error) {
        console.error(`\nError: ${error.message}`)
      }
    }
  } catch (error) {
    if (error.code !== 'ERR_USE_AFTER_CLOSE') throw error
  } finally {
    rl.close()
  }
}

await main()
