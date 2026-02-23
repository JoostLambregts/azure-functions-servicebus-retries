import { execSync, spawn, type ChildProcess } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const EMULATOR_CONNECTION_STRING =
  'Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true'

const HEALTH_URL = 'http://localhost:5300'
const MAX_WAIT_MS = 30_000
const POLL_INTERVAL_MS = 2_000
const FUNC_READY_TIMEOUT_MS = 60_000

const ROOT_DIR = path.resolve(__dirname, '../..')
const FUNC_APP_DIR = path.resolve(__dirname, 'function-app')

let funcProcess: ChildProcess | undefined

async function waitForEmulator(): Promise<void> {
  const deadline = Date.now() + MAX_WAIT_MS
  while (Date.now() < deadline) {
    try {
      const response = await fetch(HEALTH_URL)
      if (response.ok) {
        console.log('Service Bus emulator is ready')
        return
      }
    } catch {
      // emulator not ready yet
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new Error(
    `Service Bus emulator not reachable at ${HEALTH_URL} after ${MAX_WAIT_MS / 1000}s. ` +
    'Start it with: cd emulator && podman compose up -d'
  )
}

function buildLibrary(): void {
  console.log('Building library...')
  execSync('npm run build', { cwd: ROOT_DIR, stdio: 'inherit' })
  console.log('Library built successfully')
}

function buildFunctionApp(): void {
  console.log('Installing function-app dependencies...')
  execSync('npm install', { cwd: FUNC_APP_DIR, stdio: 'inherit' })
  console.log('Building function-app...')
  execSync('npm run build', { cwd: FUNC_APP_DIR, stdio: 'inherit' })
  console.log('Function-app built successfully')
}

async function startFuncHost(): Promise<void> {
  console.log('Starting Azure Functions host...')

  funcProcess = spawn('func', ['start'], {
    cwd: FUNC_APP_DIR,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SERVICEBUS_CONNECTION_STRING: EMULATOR_CONNECTION_STRING,
    },
  })

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Azure Functions host did not start within ${FUNC_READY_TIMEOUT_MS / 1000}s`))
    }, FUNC_READY_TIMEOUT_MS)

    let output = ''

    let ready = false

    funcProcess!.stdout?.on('data', (data: Buffer) => {
      const text = data.toString()
      output += text
      process.stdout.write(`[func] ${text}`)

      // The host logs function names when ready — check accumulated output
      if (!ready && output.includes('retryTestTrigger') && output.includes('expiryTestTrigger')) {
        ready = true
        clearTimeout(timeout)
        // Give it a moment to fully initialize
        setTimeout(() => resolve(), 2000)
      }
    })

    funcProcess!.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      output += text
      process.stderr.write(`[func-err] ${text}`)
    })

    funcProcess!.on('error', (err) => {
      clearTimeout(timeout)
      reject(new Error(`Failed to start func host: ${err.message}`))
    })

    funcProcess!.on('exit', (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout)
        reject(new Error(`func host exited with code ${code}.\nOutput:\n${output}`))
      }
    })
  })
}

export async function setup(): Promise<void> {
  process.env['SERVICEBUS_CONNECTION_STRING'] = EMULATOR_CONNECTION_STRING
  await waitForEmulator()
  buildLibrary()
  buildFunctionApp()
  await startFuncHost()
  console.log('Integration test setup complete')
}

export async function teardown(): Promise<void> {
  if (funcProcess && funcProcess.pid) {
    console.log('Stopping Azure Functions host...')

    // On Windows, shell-spawned processes need taskkill to terminate the tree.
    // On Unix, SIGTERM works fine.
    if (process.platform === 'win32') {
      try {
        execSync(`taskkill /pid ${funcProcess.pid} /T /F`, { stdio: 'ignore' })
      } catch {
        // process may already be gone
      }
    } else {
      funcProcess.kill('SIGTERM')
    }

    await new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => {
        if (process.platform !== 'win32') {
          funcProcess?.kill('SIGKILL')
        }
        resolve()
      }, 5000)

      funcProcess!.on('exit', () => {
        clearTimeout(forceKill)
        resolve()
      })
    })
    console.log('Azure Functions host stopped')
  }
}
