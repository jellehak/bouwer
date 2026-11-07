#!/usr/bin/env node

import { exec, execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import readline from 'node:readline/promises'
import process, { loadEnvFile } from 'node:process'
import {
  ARCHITECT_PROMPT,
  CHAT_TIMEOUT_MS,
  CONFIG_KEYS,
  DEFAULT_MODEL,
  DEFAULT_NUM_CTX,
  DEFAULT_SERVER,
  DEFAULT_TOOL_TIMEOUT_MS,
  MAX_COMMAND_BUFFER,
  MAX_OUTPUT,
  MAX_TOOL_CALLS,
  MAX_TOOL_TIMEOUT_MS,
  PERMISSION_MODES,
  TOOLS,
  WORKER_PROMPT
} from './constants.js'

const shellEnv = {
  LLM_SERVER: process.env.LLM_SERVER,
  LLM_MODEL: process.env.LLM_MODEL,
  LLM_NUM_CTX: process.env.LLM_NUM_CTX
}

try {
  loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

async function readConfigFile (filename) {
  let contents
  try {
    contents = await readFile(join(process.cwd(), filename), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw new Error(`Could not read ${filename}: ${error.message}`, { cause: error })
  }

  let config
  try {
    config = JSON.parse(contents)
  } catch (error) {
    throw new Error(`Invalid JSON in ${filename}: ${error.message}`, { cause: error })
  }

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${filename} must contain a JSON object.`)
  }

  const unknownKeys = Object.keys(config).filter(key => !CONFIG_KEYS.includes(key))
  if (unknownKeys.length > 0) {
    throw new Error(`Unknown setting${unknownKeys.length > 1 ? 's' : ''} in ${filename}: ${unknownKeys.join(', ')}.`)
  }

  for (const key of ['server', 'model', 'workspaceDir']) {
    if (config[key] !== undefined && (typeof config[key] !== 'string' || config[key].trim() === '')) {
      throw new Error(`${filename}: "${key}" must be a non-empty string.`)
    }
  }
  if (config.numCtx !== undefined && (!Number.isInteger(config.numCtx) || config.numCtx < 1)) {
    throw new Error(`${filename}: "numCtx" must be a positive integer.`)
  }
  if (config.permissionMode !== undefined && !PERMISSION_MODES.includes(config.permissionMode)) {
    throw new Error(`${filename}: "permissionMode" must be "ask" or "allow-all".`)
  }

  return config
}

const config = {
  ...await readConfigFile('bouwer.config.json'),
  ...await readConfigFile('.bouwer.json')
}

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)
let workingDirectory = process.cwd()
let planFile
let permissionMode = config.permissionMode || 'ask'
const workspaceDir = resolve(process.cwd(), config.workspaceDir || 'workspace')
const host = (shellEnv.LLM_SERVER || config.server || process.env.LLM_SERVER || DEFAULT_SERVER).replace(/\/+$/, '')
const chatEndpoint = host.endsWith('/api') ? `${host}/chat` : `${host}/api/chat`
const model = shellEnv.LLM_MODEL || config.model || process.env.LLM_MODEL || DEFAULT_MODEL
const numCtx = positiveInteger(shellEnv.LLM_NUM_CTX || config.numCtx || process.env.LLM_NUM_CTX, DEFAULT_NUM_CTX)
const historyLimit = numCtx * 2
const history = []
let summary = ''

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

function positiveInteger (value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function parseCliOptions (args) {
  let workspace
  let plan
  let help = false
  let workspaceSet = false
  let permissionModeSet = false

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') {
      help = true
    } else if (arg === '--permission-mode' || arg.startsWith('--permission-mode=')) {
      if (permissionModeSet) throw new Error('Use --permission-mode only once.')
      permissionModeSet = true
      const value = arg === '--permission-mode' ? args[++index] : arg.slice('--permission-mode='.length)
      if (!PERMISSION_MODES.includes(value)) {
        throw new Error('--permission-mode must be "ask" or "allow-all".')
      }
      permissionMode = value
    } else if (arg === '--plan' || arg.startsWith('--plan=')) {
      if (plan !== undefined) throw new Error('Use --plan only once.')
      plan = arg === '--plan' ? null : arg.slice('--plan='.length)
      if (arg === '--plan' && args[index + 1] && !args[index + 1].startsWith('-')) {
        plan = args[++index]
      }
      if (plan === '') throw new Error('--plan requires a non-empty filename.')
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

  return { help, plan, permissionMode, workspace: workspaceSet ? (workspace || null) : undefined }
}

async function readPlan (filename, optional = false) {
  let contents
  try {
    contents = await readFile(filename, 'utf8')
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null
    throw new Error(`Could not read plan ${filename}: ${error.message}`, { cause: error })
  }
  if (!contents.trim()) throw new Error(`Plan is empty: ${filename}`)
  if (contents.length > historyLimit) {
    throw new Error(`Plan exceeds the low-context limit of ${historyLimit} characters: ${filename}`)
  }
  return contents
}

async function createWorkspace (name) {
  await mkdir(workspaceDir, { recursive: true })

  if (name !== null) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || name === '.' || name === '..') {
      throw new Error('Workspace name must be 1-64 letters, numbers, dots, underscores or hyphens, and start with a letter or number.')
    }
    const directory = join(workspaceDir, name)
    try {
      await mkdir(directory)
      return { directory, created: true }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }

    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Workspace path is not a regular directory: ${directory}`)
    }

    while (true) {
      const answer = (await rl.question(
        `\nWorkspace bestaat al: ${directory}\n[c] Doorgaan / [o] Opnieuw beginnen (met back-up) / [a] Annuleren [c]: `
      )).trim().toLowerCase()
      if (answer === '' || answer === 'c') return { directory, created: false }
      if (answer === 'a') return null
      if (answer === 'o') {
        const backup = `${directory}.backup-${randomUUID()}`
        await rename(directory, backup)
        console.log(`Back-up opgeslagen: ${backup}`)
        await mkdir(directory)
        return { directory, created: true }
      }
      console.error('Kies c, o of a.')
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (let suffix = 0; ; suffix++) {
    const directory = join(workspaceDir, suffix ? `${timestamp}-${suffix}` : timestamp)
    try {
      await mkdir(directory)
      return { directory, created: true }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
}

function shorten (text) {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n[output truncated]` : text
}

function color (text, code, stream = process.stdout) {
  return stream.isTTY && process.env.NO_COLOR === undefined
    ? `\x1b[${code}m${text}\x1b[0m`
    : text
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
      process.stderr.write(`\r${color(`${frames[frame++ % frames.length]} ${label} (${elapsed}s)`, '36', process.stderr)}`)
    } else if (Date.now() - lastReported >= 5000) {
      process.stderr.write(`... ${label} (${elapsed}s)\n`)
      lastReported = Date.now()
    }
  }

  process.stderr.write(`${color(`⏳ ${label}`, '36', process.stderr)}\n`)
  const timer = setInterval(render, tty ? 100 : 1000)
  timer.unref()

  try {
    const result = await operation()
    clearInterval(timer)
    const elapsed = ((Date.now() - started) / 1000).toFixed(1)
    if (tty) process.stderr.write(`\r\x1b[2K`)
    process.stderr.write(`${color(`✅ ${label} (${elapsed}s)`, '32', process.stderr)}\n`)
    return result
  } catch (error) {
    clearInterval(timer)
    const elapsed = ((Date.now() - started) / 1000).toFixed(1)
    if (tty) process.stderr.write(`\r\x1b[2K`)
    process.stderr.write(`${color(`❌ ${label} (${elapsed}s)`, '31', process.stderr)}\n`)
    throw error
  }
}

async function askApproval (name, value, timeout) {
  const title = name === 'run_command' ? 'Terminalcommando' : 'Node.js-script'
  const lines = value.split(/\r?\n/)
  const width = String(lines.length).length
  const separator = '─'.repeat(60)

  console.log(`\n${color(`🔐 Toestemming nodig: ${title}`, '1;33')}`)
  console.log(`📁 Werkmap: ${workingDirectory}`)
  console.log(`⏱  Timeout: ${timeout / 1000}s`)
  console.log(color('⚠️  Kan bestanden wijzigen of verwijderen en netwerkverzoeken uitvoeren.', '33'))
  console.log(color(separator, '2'))
  for (const [index, line] of lines.entries()) {
    console.log(`${color(String(index + 1).padStart(width), '2')} │ ${line}`)
  }
  console.log(color(separator, '2'))
  while (true) {
    const answer = (await rl.question(
      `${color('▶ Uitvoeren?', '1;33')} [y/ja = toestaan, n/nee/Enter = weigeren]: `
    )).trim().toLowerCase()
    if (['y', 'yes', 'j', 'ja'].includes(answer)) {
      console.log(color('✅ Toegestaan.', '32'))
      return true
    }
    if (['', 'n', 'no', 'nee'].includes(answer)) {
      console.log(color('🚫 Geweigerd; niets uitgevoerd.', '33'))
      return false
    }
    console.error('Kies y/ja om toe te staan of n/nee om te weigeren.')
  }
}

async function runTool (name, args) {
  if (name !== 'run_command' && name !== 'run_node') {
    return `Unknown tool: ${name}`
  }

  const value = name === 'run_command' ? args.command : args.code
  if (typeof value !== 'string' || value.length === 0) {
    return `Invalid ${name} input: expected a non-empty ${name === 'run_command' ? 'command' : 'code'} string.`
  }

  const timeout = Math.min(positiveInteger(args.timeout_ms, DEFAULT_TOOL_TIMEOUT_MS), MAX_TOOL_TIMEOUT_MS)
  const approved = permissionMode === 'allow-all' ||
    await askApproval(name, value, timeout)
  if (!approved) return 'Command not run: user declined approval.'

  return withStatus(name === 'run_command' ? 'Terminalcommando uitvoeren' : 'Node.js-script uitvoeren', async () => {
    try {
      const options = { timeout, maxBuffer: MAX_COMMAND_BUFFER, cwd: workingDirectory }
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
        ...(withTools ? { tools: TOOLS } : {}),
        options: { num_ctx: numCtx, temperature: 0.2 }
      }),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS)
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`LLM server returned ${response.status}: ${body}`)
    }

    const data = await response.json()
    if (!data.message) throw new Error('LLM server response did not contain a message.')
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
    { role: 'system', content: ARCHITECT_PROMPT },
    ...(summary ? [{ role: 'user', content: `Project conversation summary:\n${summary}` }] : []),
    { role: 'user', content: request }
  ]
  let plan = planFile ? await readPlan(planFile, true) : null
  if (!plan) {
    if (planFile) {
      architectMessages[0] = {
        role: 'system',
        content: `${ARCHITECT_PROMPT}\nReturn a Markdown plan with a short goal and at most 5 unchecked "- [ ]" tasks.`
      }
    }
    plan = (await chat(architectMessages, false, 'Architect maakt plan')).content?.trim()
    if (planFile && plan) {
      if (plan.length > historyLimit) throw new Error('Generated plan exceeds the low-context limit.')
      await writeFile(planFile, `${plan}\n`, { flag: 'wx' })
      console.log(`Plan opgeslagen: ${planFile}`)
    }
  }
  if (!plan) throw new Error('The architect returned an empty plan.')

  const messages = [
    {
      role: 'system',
      content: planFile
        ? `${WORKER_PROMPT}\nWorking directory: ${workingDirectory}\nPersistent plan: ${planFile}\nRead and follow this plan. Preserve its goals and existing completed tasks. Use the existing tools to mark tasks [x] only after completing and verifying them; leave blocked or unfinished tasks unchecked. These file edits also require approval. For follow-up requests, update the plan rather than replacing it.`
        : WORKER_PROMPT
    },
    ...(summary ? [{ role: 'system', content: `Conversation summary:\n${summary}` }] : []),
    ...history.slice(-6),
    { role: 'user', content: `Architect's plan:\n${plan}\n\nUser request:\n${request}` }
  ]

  for (let call = 0; call < MAX_TOOL_CALLS; call++) {
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

  throw new Error(`Stopped after ${MAX_TOOL_CALLS} tool rounds. Send a follow-up to continue.`)
}

function printHelp () {
  console.log(`
Bouwer - a low-context coding assistant

Usage:
  bouwer [--workspace [name]] [--plan [file]] [--permission-mode ask|allow-all]

Options:
  --workspace [name]  Create and use <workspaceDir>/<name>; omit name to generate one
  --plan [file]       Execute an existing plan; omit file to use or create plan.md
  --permission-mode   Set tool permissions to "ask" or "allow-all"
  -h, --help          Show this help

Commands:
  :help   Show this help
  :clear  Clear conversation history and its summary
  :exit   Quit

Environment:
  LLM_SERVER      Server URL (default: http://127.0.0.1:11434)
  LLM_MODEL       Model name (default: qwen2.5-coder:7b)
  LLM_NUM_CTX     Context size (default: 4096)

Config:
  bouwer.config.json  Shared project settings
  .bouwer.json        Personal settings (ignored by git)
  permissionMode      "ask" (default) or "allow-all"
`)
}

async function main () {
  const options = parseCliOptions(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }
  permissionMode = options.permissionMode

  const sourcePlan = options.plan !== undefined ? resolve(options.plan || 'plan.md') : null
  let existingPlan = sourcePlan ? await readPlan(sourcePlan, options.plan === null) : null

  if (options.workspace !== undefined) {
    const workspace = await createWorkspace(options.workspace)
    if (!workspace) {
      console.log('Geannuleerd.')
      return
    }
    workingDirectory = workspace.directory
    console.log(`Workspace ${workspace.created ? 'aangemaakt' : 'hervat'}: ${workingDirectory}`)
  }

  if (sourcePlan) {
    planFile = join(workingDirectory, basename(sourcePlan))
    if (options.workspace === undefined) planFile = sourcePlan
    if (planFile !== sourcePlan) {
      const workspacePlan = await readPlan(planFile, true)
      if (workspacePlan) {
        existingPlan = workspacePlan
      } else if (existingPlan) {
        await writeFile(planFile, existingPlan, { flag: 'wx' })
      }
    }
    console.log(`Plan: ${planFile}`)
  }

  console.log(`Bouwer | ${model} | context ${numCtx} | ${workingDirectory}`)
  console.log(`Tool permission mode: ${permissionMode}. Type :help for commands.`)

  try {
    if (existingPlan) {
      try {
        await handleTurn('Execute the remaining work in the plan document. Preserve completed tasks and report unfinished work.')
      } catch (error) {
        console.error(`\nError: ${error.message}`)
      }
    }
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

try {
  await main()
} catch (error) {
  console.error(`\nError: ${error.message}`)
  process.exitCode = 1
} finally {
  rl.close()
}
