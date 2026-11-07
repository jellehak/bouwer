export const DEFAULT_SERVER = 'http://127.0.0.1:11434'
export const DEFAULT_MODEL = 'qwen2.5-coder:7b'
export const DEFAULT_NUM_CTX = 4096

export const MAX_TOOL_CALLS = 8
export const MAX_OUTPUT = 64 * 1024
export const DEFAULT_TOOL_TIMEOUT_MS = 30000
export const MAX_TOOL_TIMEOUT_MS = 120000
export const CHAT_TIMEOUT_MS = 180000
export const MAX_COMMAND_BUFFER = 1024 * 1024

export const PERMISSION_MODES = ['ask', 'allow-all']
export const CONFIG_KEYS = ['server', 'model', 'numCtx', 'workspaceDir', 'permissionMode']

export const ARCHITECT_PROMPT = `You are the architect in a small coding assistant.
Make a concise plan for the worker based on the user's request. Use the supplied project summary if present.
Do not execute tools or write the solution. Keep the plan to at most 5 short steps.`

export const WORKER_PROMPT = `You are a practical coding assistant working in the current project directory.
Follow the architect's plan and complete the user's request. Be concise and use tools only when needed.
You may execute Node.js code or terminal commands using the available tools. Never claim a command ran unless its output confirms it.
Tool permissions follow the configured permission mode. Work in small, verifiable steps and report what changed.`

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command in the current project directory.',
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
      description: 'Execute JavaScript source with the current Node.js runtime.',
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
