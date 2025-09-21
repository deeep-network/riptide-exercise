import type { HookContext } from '@deeep-network/riptide'
import { spawn, ChildProcess } from 'child_process'
import { InvalidSecretError } from '@deeep-network/riptide'
import * as fs from 'fs/promises'
import { createInterface } from 'readline'

const CONFIG = {
  BINARY_PATH: process.env.BINARY_PATH || '/app/binary',
  SECRET_KEY: process.env.BINARY_SECRET_KEY || 'DEEEP_NETWORK',
  HEALTH_CHECK_INTERVAL: parseInt(process.env.HEALTH_CHECK_INTERVAL || '1000'),
  STARTUP_GRACE_PERIOD: parseInt(process.env.STARTUP_GRACE_PERIOD || '5000'),
  MAX_RESTART_ATTEMPTS: parseInt(process.env.MAX_RESTART_ATTEMPTS || '3'),
  RESTART_DELAY: parseInt(process.env.RESTART_DELAY || '2000'),
  AUTO_KEY_INJECTION: process.env.AUTO_KEY_INJECTION === 'true',
  MAX_LOG_LINES: parseInt(process.env.MAX_LOG_LINES || '1000'),
  SHUTDOWN_TIMEOUT: parseInt(process.env.SHUTDOWN_TIMEOUT || '10000'),
  HEALTH_CACHE_TTL: parseInt(process.env.HEALTH_CACHE_TTL || '500'),
} as const

const UPTIME_PATTERNS = [
  /uptime[:\s]+(\d+(?:\.\d+)?)\s*(?:seconds?|s)/i,
  /running\s+for[:\s]+(\d+(?:\.\d+)?)\s*(?:seconds?|s)/i,
  /alive[:\s]+(\d+(?:\.\d+)?)\s*(?:seconds?|s)/i,
]

const ERROR_KEYWORDS = new Set(['error', 'exception', 'failed', 'critical', 'fatal'])

class CircularBuffer<T> {
  private buffer: (T | undefined)[]
  private head: number = 0
  private size: number = 0
  
  constructor(private capacity: number) {
    this.buffer = new Array(capacity)
  }
  
  push(item: T): void {
    this.buffer[this.head] = item
    this.head = (this.head + 1) % this.capacity
    this.size = Math.min(this.size + 1, this.capacity)
  }
  
  getRecent(n: number): T[] {
    const result: T[] = []
    const count = Math.min(n, this.size)
    
    for (let i = 0; i < count; i++) {
      const idx = (this.head - count + i + this.capacity) % this.capacity
      if (this.buffer[idx] !== undefined) {
        result.push(this.buffer[idx]!)
      }
    }
    return result
  }
  
  clear(): void {
    this.buffer = new Array(this.capacity)
    this.head = 0
    this.size = 0
  }
}

interface ProcessState {
  process: ChildProcess | null
  startTime: number
  lastUptime: number
  isHealthy: boolean
  restartCount: number
  logs: CircularBuffer<string>
  metrics: PerformanceMetrics
  healthCache: HealthCacheEntry | null
}

interface HealthMetrics {
  uptime: number
  isRunning: boolean
  hasErrors: boolean
  uptimeIncreasing: boolean
}

interface PerformanceMetrics {
  lastHealthCheckDuration: number
  avgHealthCheckDuration: number
  totalHealthChecks: number
  lastRestartTime: number
  memoryUsage: number
  logProcessingTime: number
}

interface HealthCacheEntry {
  metrics: HealthMetrics
  timestamp: number
}

class BinaryStartError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BinaryStartError'
  }
}

const delay = (ms: number): Promise<void> => 
  new Promise(resolve => setTimeout(resolve, ms))

const extractUptimeFromLogs = (logs: CircularBuffer<string>): number => {
  const recentLogs = logs.getRecent(50)
  
  for (let i = recentLogs.length - 1; i >= 0; i--) {
    for (const pattern of UPTIME_PATTERNS) {
      const match = recentLogs[i].match(pattern)
      if (match) {
        return parseFloat(match[1])
      }
    }
  }
  
  return 0
}

const isProcessRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const calculateBackoff = (
  attempt: number, 
  baseDelay: number = 1000, 
  maxDelay: number = 30000
): number => {
  const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay)
  const jitter = Math.random() * 0.3 * delay
  return Math.floor(delay + jitter)
}

const processState: ProcessState = {
  process: null,
  startTime: 0,
  lastUptime: 0,
  isHealthy: false,
  restartCount: 0,
  logs: new CircularBuffer<string>(CONFIG.MAX_LOG_LINES),
  metrics: {
    lastHealthCheckDuration: 0,
    avgHealthCheckDuration: 0,
    totalHealthChecks: 0,
    lastRestartTime: 0,
    memoryUsage: 0,
    logProcessingTime: 0
  },
  healthCache: null
}

const createBinaryWrapper = async (logger: any): Promise<string> => {
  const wrapperPath = '/app/binary-wrapper.sh'
  const wrapperContent = `#!/bin/bash
if [[ "$1" == "--key="* ]]; then
  exec ${CONFIG.BINARY_PATH} "$@"
elif [[ "$1" == "start" ]]; then
  ${CONFIG.BINARY_PATH} --key="${CONFIG.SECRET_KEY}" || exit $?
  exec ${CONFIG.BINARY_PATH} start
else
  exec ${CONFIG.BINARY_PATH} "$@"
fi
`
  
  try {
    await fs.writeFile(wrapperPath, wrapperContent, { mode: 0o755 })
    logger.info('Binary wrapper created for automatic key injection')
    return wrapperPath
  } catch (error) {
    logger.error('Failed to create binary wrapper:', error)
    return CONFIG.BINARY_PATH
  }
}

const startBinaryProcess = async (
  binaryPath: string, 
  logger: any,
  useWrapper: boolean = false
): Promise<ChildProcess> => {
  const startCommand = useWrapper ? binaryPath : CONFIG.BINARY_PATH
  
  return new Promise((resolve, reject) => {
    logger.info(`Starting binary process: ${startCommand}`)
    
    if (!useWrapper) {
      const keyProcess = spawn(CONFIG.BINARY_PATH, [`--key=${CONFIG.SECRET_KEY}`], {
        cwd: '/app',
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      
      let keyOutput = ''
      let keyError = ''
      
      keyProcess.stdout.on('data', (data) => {
        keyOutput += data.toString()
      })
      
      keyProcess.stderr.on('data', (data) => {
        keyError += data.toString()
      })
      
      keyProcess.on('exit', (code) => {
        if (code !== 0) {
          logger.error(`Key setting failed: ${keyError}`)
          reject(new InvalidSecretError('Failed to set binary key'))
          return
        }
        
        logger.info('Binary key set successfully')
        const binaryProcess = spawn(CONFIG.BINARY_PATH, ['start'], {
          cwd: '/app',
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe']
        })
        
        resolve(binaryProcess)
      })
    } else {
      const binaryProcess = spawn(startCommand, ['start'], {
        cwd: '/app',
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      
      resolve(binaryProcess)
    }
  })
}

const monitorProcessLogs = (childProcess: ChildProcess, logger: any): void => {
  processState.logs.clear()
  const stdoutReader = createInterface({
    input: childProcess.stdout!,
    crlfDelay: Infinity
  })
  
  stdoutReader.on('line', (line) => {
    const startTime = process.hrtime.bigint()
    
    logger.debug(`[BINARY STDOUT] ${line}`)
    processState.logs.push(line)
    
    const endTime = process.hrtime.bigint()
    processState.metrics.logProcessingTime = Number(endTime - startTime) / 1000000
  })
  
  const stderrReader = createInterface({
    input: childProcess.stderr!,
    crlfDelay: Infinity
  })
  
  stderrReader.on('line', (line) => {
    logger.warn(`[BINARY STDERR] ${line}`)
    processState.logs.push(`ERROR: ${line}`)
    
    const lowerLine = line.toLowerCase()
    if (lowerLine.indexOf('invalid') !== -1 && lowerLine.indexOf('secret') !== -1) {
      logger.error('Invalid secret detected in binary output')
      childProcess.kill('SIGTERM')
    }
  })
}

const checkBinaryHealth = async (logger: any): Promise<HealthMetrics> => {
  const startTime = process.hrtime.bigint()
  
  if (processState.healthCache && 
      (Date.now() - processState.healthCache.timestamp) < CONFIG.HEALTH_CACHE_TTL) {
    return processState.healthCache.metrics
  }
  
  const metrics: HealthMetrics = {
    uptime: 0,
    isRunning: false,
    hasErrors: false,
    uptimeIncreasing: false
  }
  
  if (!processState.process || !processState.process.pid) {
    return metrics
  }
  
  metrics.isRunning = isProcessRunning(processState.process.pid)
  
  if (!metrics.isRunning) {
    logger.warn('Binary process is not running')
    return metrics
  }
  
  metrics.uptime = extractUptimeFromLogs(processState.logs)
  
  if (metrics.uptime > processState.lastUptime) {
    metrics.uptimeIncreasing = true
    processState.lastUptime = metrics.uptime
  } else if (Date.now() - processState.startTime > CONFIG.STARTUP_GRACE_PERIOD) {
    metrics.uptimeIncreasing = false
    logger.warn(`Uptime not increasing: current=${metrics.uptime}, last=${processState.lastUptime}`)
  }
  
  const recentLogs = processState.logs.getRecent(50)
  metrics.hasErrors = recentLogs.some(log => {
    const lowerLog = log.toLowerCase()
    for (const keyword of ERROR_KEYWORDS) {
      if (lowerLog.indexOf(keyword) !== -1) {
        return true
      }
    }
    return false
  })
  
  processState.healthCache = {
    metrics: { ...metrics },
    timestamp: Date.now()
  }
  
  const endTime = process.hrtime.bigint()
  const duration = Number(endTime - startTime) / 1000000
  processState.metrics.lastHealthCheckDuration = duration
  processState.metrics.totalHealthChecks++
  processState.metrics.avgHealthCheckDuration = 
    (processState.metrics.avgHealthCheckDuration * (processState.metrics.totalHealthChecks - 1) + duration) / 
    processState.metrics.totalHealthChecks
  
  processState.metrics.memoryUsage = process.memoryUsage().heapUsed
  
  return metrics
}

module.exports = {
  installSecrets: async ({ env, logger }: HookContext) => {
    logger.info('Installing secrets for binary management')
    
    try {
      try {
        await fs.access(CONFIG.BINARY_PATH, fs.constants.X_OK)
        logger.info('Binary found and is executable')
      } catch {
        throw new Error(`Binary not found or not executable at ${CONFIG.BINARY_PATH}`)
      }
      
      const requiredEnvVars = ['NODE_ENV']
      for (const envVar of requiredEnvVars) {
        if (!env[envVar]) {
          logger.warn(`Optional environment variable ${envVar} not set`)
        }
      }
      
      const wrapperPath = await createBinaryWrapper(logger)
      
      ;(global as any).binaryWrapperPath = wrapperPath
      
      logger.info('Secrets installation completed successfully')
      return { success: true }
    } catch (error) {
      logger.error(`Failed to install secrets: ${error}`)
      throw error
    }
  },

  heartbeat: async ({}: HookContext) => {
    const metrics = processState.metrics
    const uptime = Date.now() - processState.startTime
    
    return {
      alive: processState.isHealthy,
      uptime: Math.floor(uptime / 1000),
      pid: processState.process?.pid || null,
      restartCount: processState.restartCount,
      performance: {
        avgHealthCheckDuration: parseFloat(metrics.avgHealthCheckDuration.toFixed(2)),
        memoryUsageMB: parseFloat((metrics.memoryUsage / 1024 / 1024).toFixed(2)),
        totalHealthChecks: metrics.totalHealthChecks
      },
      binary: {
        isRunning: processState.process?.pid ? isProcessRunning(processState.process.pid) : false,
        lastUptime: processState.lastUptime
      }
    }
  },

  start: async ({ env, logger }: HookContext) => {
    logger.info('Starting binary service')
    
    try {
      processState.startTime = Date.now()
      processState.lastUptime = 0
      processState.isHealthy = false
      processState.restartCount = 0
      processState.logs.clear()
      processState.healthCache = null
      processState.metrics = {
        lastHealthCheckDuration: 0,
        avgHealthCheckDuration: 0,
        totalHealthChecks: 0,
        lastRestartTime: 0,
        memoryUsage: 0,
        logProcessingTime: 0
      }
      
      const useWrapper = CONFIG.AUTO_KEY_INJECTION || env.AUTO_KEY_INJECTION === 'true'
      const binaryPath = useWrapper && (global as any).binaryWrapperPath 
        ? (global as any).binaryWrapperPath 
        : CONFIG.BINARY_PATH
      
      processState.process = await startBinaryProcess(binaryPath, logger, useWrapper)
      
      if (!processState.process.pid) {
        throw new BinaryStartError('Failed to obtain process PID')
      }
      
      logger.info(`Binary started with PID: ${processState.process.pid}`)
      
      monitorProcessLogs(processState.process, logger)
      
      processState.process.on('exit', (code, signal) => {
        logger.error(`Binary process exited with code ${code} and signal ${signal}`)
        processState.isHealthy = false
        
        if (processState.restartCount < CONFIG.MAX_RESTART_ATTEMPTS) {
          processState.restartCount++
          logger.info(`Attempting restart ${processState.restartCount}/${CONFIG.MAX_RESTART_ATTEMPTS}`)
          
          const backoffDelay = calculateBackoff(processState.restartCount - 1, CONFIG.RESTART_DELAY)
          processState.metrics.lastRestartTime = Date.now()
          
          setTimeout(async () => {
            try {
              processState.process = await startBinaryProcess(binaryPath, logger, useWrapper)
              monitorProcessLogs(processState.process!, logger)
              processState.startTime = Date.now()
              processState.healthCache = null
            } catch (error) {
              logger.error(`Failed to restart binary: ${error}`)
            }
          }, backoffDelay)
        } else {
          logger.error('Maximum restart attempts reached. Manual intervention required.')
        }
      })
      
      await delay(CONFIG.STARTUP_GRACE_PERIOD)
      
      const health = await checkBinaryHealth(logger)
      processState.isHealthy = health.isRunning && (health.uptimeIncreasing || health.uptime > 0)
      
      logger.info(`Binary startup completed. Initial health: ${processState.isHealthy}`)
      
    } catch (error) {
      logger.error(`Failed to start binary: ${error}`)
      throw error
    }
  },

  health: async ({ logger }: HookContext) => {
    try {
      const metrics = await checkBinaryHealth(logger)
      
      const isHealthy = metrics.isRunning && 
                       !metrics.hasErrors && 
                       (metrics.uptimeIncreasing || metrics.uptime > 0)
      
      processState.isHealthy = isHealthy
      
      logger.info(`Health check completed - healthy: ${isHealthy}, uptime: ${metrics.uptime}s, running: ${metrics.isRunning}, uptimeIncreasing: ${metrics.uptimeIncreasing}, hasErrors: ${metrics.hasErrors}, restartCount: ${processState.restartCount}, avgHealthCheckDuration: ${processState.metrics.avgHealthCheckDuration.toFixed(2)}ms, memoryUsage: ${(processState.metrics.memoryUsage / 1024 / 1024).toFixed(2)}MB`)
      
      return isHealthy
    } catch (error) {
      logger.error(`Health check failed: ${error}`)
      return false
    }
  },

  stop: async ({ logger }: HookContext) => {
    logger.info('Stopping binary service')
    
    try {
      if (!processState.process) {
        logger.warn('No process to stop')
        return
      }
      
      processState.process.kill('SIGTERM')
      logger.info('Sent SIGTERM to binary process')
      
      let shutdownComplete = false
      const shutdownTimeout = CONFIG.SHUTDOWN_TIMEOUT
      const startTime = Date.now()
      
      while (!shutdownComplete && (Date.now() - startTime) < shutdownTimeout) {
        if (!processState.process.pid || !isProcessRunning(processState.process.pid)) {
          shutdownComplete = true
          break
        }
        await delay(100)
      }
      
      if (!shutdownComplete && processState.process.pid) {
        logger.warn('Graceful shutdown timeout, forcing kill')
        processState.process.kill('SIGKILL')
      }
      
      if ((global as any).binaryWrapperPath && (global as any).binaryWrapperPath !== CONFIG.BINARY_PATH) {
        try {
          await fs.unlink((global as any).binaryWrapperPath)
          logger.info('Cleaned up binary wrapper')
        } catch (error) {
          logger.warn(`Failed to clean up wrapper: ${error}`)
        }
      }
      
      processState.process = null
      processState.isHealthy = false
      processState.logs.clear()
      processState.healthCache = null
      
      logger.info('Binary service stopped successfully')
    } catch (error) {
      logger.error(`Error during shutdown: ${error}`)
      throw error
    }
  }
}