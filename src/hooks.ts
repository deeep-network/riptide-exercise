import type { HookContext } from '@deeep-network/riptide'
import { spawn, ChildProcess } from 'child_process'
import { MissingSecretError, InvalidSecretError } from '@deeep-network/riptide'
import * as fs from 'fs/promises'
import { createInterface } from 'readline'

// =============================================================================
// CONFIGURATION - Environment-based configuration management
// =============================================================================
const CONFIG = {
  // Binary configuration
  BINARY_PATH: process.env.BINARY_PATH || '/app/binary',
  SECRET_KEY: process.env.BINARY_SECRET_KEY || 'DEEEP_NETWORK',
  
  // Health check configuration
  HEALTH_CHECK_INTERVAL: parseInt(process.env.HEALTH_CHECK_INTERVAL || '1000'),
  STARTUP_GRACE_PERIOD: parseInt(process.env.STARTUP_GRACE_PERIOD || '5000'),
  
  // Restart configuration
  MAX_RESTART_ATTEMPTS: parseInt(process.env.MAX_RESTART_ATTEMPTS || '3'),
  RESTART_DELAY: parseInt(process.env.RESTART_DELAY || '2000'),
  
  // Feature flags
  USE_WRAPPER: process.env.USE_WRAPPER === 'true',
  AUTO_KEY_INJECTION: process.env.AUTO_KEY_INJECTION === 'true',
  ENABLE_METRICS: process.env.ENABLE_METRICS === 'true',
  
  // Logging configuration
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  LOG_FORMAT: process.env.LOG_FORMAT || 'json',
  
  // Performance tuning
  MAX_LOG_LINES: parseInt(process.env.MAX_LOG_LINES || '1000'),
  SHUTDOWN_TIMEOUT: parseInt(process.env.SHUTDOWN_TIMEOUT || '10000'),
  
  // Optimization settings
  HEALTH_CACHE_TTL: parseInt(process.env.HEALTH_CACHE_TTL || '500'),
  LOG_BUFFER_SIZE: parseInt(process.env.LOG_BUFFER_SIZE || '100'),
} as const

// =============================================================================
// PERFORMANCE OPTIMIZATIONS - Pre-compiled patterns and constants
// =============================================================================
// Pre-compiled regex patterns for better performance
const UPTIME_PATTERNS = [
  /uptime[:\s]+(\d+(?:\.\d+)?)\s*(?:seconds?|s)/i,
  /running\s+for[:\s]+(\d+(?:\.\d+)?)\s*(?:seconds?|s)/i,
  /alive[:\s]+(\d+(?:\.\d+)?)\s*(?:seconds?|s)/i,
]

// Use Set for O(1) error keyword lookups
const ERROR_KEYWORDS = new Set(['error', 'exception', 'failed', 'critical', 'fatal'])

// Pre-allocated buffer for string operations
const STRING_BUFFER_SIZE = 1024

// =============================================================================
// CIRCULAR BUFFER - Optimized log storage
// =============================================================================
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
  
  getAll(): T[] {
    const result: T[] = []
    const start = this.size === this.capacity ? this.head : 0
    const count = this.size
    
    for (let i = 0; i < count; i++) {
      const idx = (start + i) % this.capacity
      if (this.buffer[idx] !== undefined) {
        result.push(this.buffer[idx]!)
      }
    }
    return result
  }
  
  getRecent(n: number): T[] {
    const all = this.getAll()
    return all.slice(-n)
  }
  
  clear(): void {
    this.buffer = new Array(this.capacity)
    this.head = 0
    this.size = 0
  }
}

// =============================================================================
// TYPES - TypeScript interfaces and types
// =============================================================================
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

enum BinaryStatus {
  STOPPED = 'stopped',
  STARTING = 'starting',
  RUNNING = 'running',
  UNHEALTHY = 'unhealthy',
  RESTARTING = 'restarting',
  FAILED = 'failed'
}

// Custom Error Classes
class BinaryStartError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BinaryStartError'
  }
}

class HealthCheckError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HealthCheckError'
  }
}

// =============================================================================
// UTILITY FUNCTIONS - Helper functions for binary management
// =============================================================================

/**
 * Create a delay promise
 */
const delay = (ms: number): Promise<void> => 
  new Promise(resolve => setTimeout(resolve, ms))

/**
 * Parse uptime from log strings
 */
const extractUptimeFromLogs = (logs: CircularBuffer<string>): number => {
  const recentLogs = logs.getRecent(50) // Only check recent logs
  
  // Iterate from newest to oldest
  for (let i = recentLogs.length - 1; i >= 0; i--) {
    // Use pre-compiled patterns
    for (const pattern of UPTIME_PATTERNS) {
      const match = recentLogs[i].match(pattern)
      if (match) {
        return parseFloat(match[1])
      }
    }
  }
  
  return 0
}

/**
 * Check if a process is running
 */
const isProcessRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Calculate exponential backoff delay
 */
const calculateBackoff = (
  attempt: number, 
  baseDelay: number = 1000, 
  maxDelay: number = 30000
): number => {
  const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay)
  const jitter = Math.random() * 0.3 * delay // 30% jitter
  return Math.floor(delay + jitter)
}

// =============================================================================
// GLOBAL STATE MANAGEMENT
// =============================================================================
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

// =============================================================================
// BINARY WRAPPER SCRIPT CREATOR (BONUS FEATURE)
// =============================================================================
const createBinaryWrapper = async (logger: any): Promise<string> => {
  const wrapperPath = '/app/binary-wrapper.sh'
  const wrapperContent = `#!/bin/bash
# Auto-generated wrapper script for automatic key injection

# Check if we're being called with --key
if [[ "$1" == "--key="* ]]; then
  # Pass through the key command
  exec ${CONFIG.BINARY_PATH} "$@"
elif [[ "$1" == "start" ]]; then
  # Auto-inject the key before starting
  ${CONFIG.BINARY_PATH} --key="${CONFIG.SECRET_KEY}" || exit $?
  exec ${CONFIG.BINARY_PATH} start
else
  # Pass through any other commands
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

// =============================================================================
// PROCESS MANAGEMENT FUNCTIONS
// =============================================================================
const startBinaryProcess = async (
  binaryPath: string, 
  logger: any,
  useWrapper: boolean = false
): Promise<ChildProcess> => {
  const startCommand = useWrapper ? binaryPath : CONFIG.BINARY_PATH
  
  return new Promise((resolve, reject) => {
    logger.info(`Starting binary process: ${startCommand}`)
    
    // First, set the key if not using wrapper
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
        
        // Now start the binary
        const binaryProcess = spawn(CONFIG.BINARY_PATH, ['start'], {
          cwd: '/app',
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe']
        })
        
        resolve(binaryProcess)
      })
    } else {
      // Using wrapper, just start directly
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
  // Clear previous logs
  processState.logs.clear()
  
  // Monitor stdout
  const stdoutReader = createInterface({
    input: childProcess.stdout!,
    crlfDelay: Infinity
  })
  
  stdoutReader.on('line', (line) => {
    const startTime = process.hrtime.bigint()
    
    logger.debug(`[BINARY STDOUT] ${line}`)
    processState.logs.push(line)
    
    // Update log processing time metric
    const endTime = process.hrtime.bigint()
    processState.metrics.logProcessingTime = Number(endTime - startTime) / 1000000 // Convert to ms
  })
  
  // Monitor stderr
  const stderrReader = createInterface({
    input: childProcess.stderr!,
    crlfDelay: Infinity
  })
  
  stderrReader.on('line', (line) => {
    logger.warn(`[BINARY STDERR] ${line}`)
    processState.logs.push(`ERROR: ${line}`)
    
    // Optimized error checking using indexOf for common case
    const lowerLine = line.toLowerCase()
    if (lowerLine.indexOf('invalid') !== -1 && lowerLine.indexOf('secret') !== -1) {
      logger.error('Invalid secret detected in binary output')
      childProcess.kill('SIGTERM')
    }
  })
}

const checkBinaryHealth = async (logger: any): Promise<HealthMetrics> => {
  const startTime = process.hrtime.bigint()
  
  // Check cache first
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
  
  // Check if process is still running
  metrics.isRunning = isProcessRunning(processState.process.pid)
  
  if (!metrics.isRunning) {
    logger.warn('Binary process is not running')
    return metrics
  }
  
  // Extract uptime from logs
  metrics.uptime = extractUptimeFromLogs(processState.logs)
  
  // Check if uptime is increasing
  if (metrics.uptime > processState.lastUptime) {
    metrics.uptimeIncreasing = true
    processState.lastUptime = metrics.uptime
  } else if (Date.now() - processState.startTime > CONFIG.STARTUP_GRACE_PERIOD) {
    // Only consider it a problem after grace period
    metrics.uptimeIncreasing = false
    logger.warn(`Uptime not increasing: current=${metrics.uptime}, last=${processState.lastUptime}`)
  }
  
  // Optimized error checking using Set
  const recentLogs = processState.logs.getRecent(50)
  metrics.hasErrors = recentLogs.some(log => {
    const lowerLog = log.toLowerCase()
    // Check each error keyword
    for (const keyword of ERROR_KEYWORDS) {
      if (lowerLog.indexOf(keyword) !== -1) {
        return true
      }
    }
    return false
  })
  
  // Update cache
  processState.healthCache = {
    metrics: { ...metrics },
    timestamp: Date.now()
  }
  
  // Update performance metrics
  const endTime = process.hrtime.bigint()
  const duration = Number(endTime - startTime) / 1000000 // Convert to ms
  processState.metrics.lastHealthCheckDuration = duration
  processState.metrics.totalHealthChecks++
  processState.metrics.avgHealthCheckDuration = 
    (processState.metrics.avgHealthCheckDuration * (processState.metrics.totalHealthChecks - 1) + duration) / 
    processState.metrics.totalHealthChecks
  
  // Update memory usage
  processState.metrics.memoryUsage = process.memoryUsage().heapUsed
  
  return metrics
}

// =============================================================================
// RIPTIDE HOOKS IMPLEMENTATION
// =============================================================================
module.exports = {
  installSecrets: async ({ env, logger }: HookContext) => {
    logger.info('Installing secrets for binary management')
    
    try {
      // Check if binary exists and is executable
      try {
        await fs.access(CONFIG.BINARY_PATH, fs.constants.X_OK)
        logger.info('Binary found and is executable')
      } catch {
        throw new Error(`Binary not found or not executable at ${CONFIG.BINARY_PATH}`)
      }
      
      // Validate environment variables if needed
      const requiredEnvVars = ['NODE_ENV']
      for (const envVar of requiredEnvVars) {
        if (!env[envVar]) {
          logger.warn(`Optional environment variable ${envVar} not set`)
        }
      }
      
      // Create wrapper script for bonus feature
      const wrapperPath = await createBinaryWrapper(logger)
      
      // Store wrapper path for later use
      ;(global as any).binaryWrapperPath = wrapperPath
      
      logger.info('Secrets installation completed successfully')
      return { success: true }
    } catch (error) {
      logger.error(`Failed to install secrets: ${error}`)
      throw error
    }
  },

  start: async ({ env, logger }: HookContext) => {
    logger.info('Starting binary service')
    
    try {
      // Reset state
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
      
      // Determine if we should use the wrapper (bonus feature)
      const useWrapper = CONFIG.AUTO_KEY_INJECTION || env.AUTO_KEY_INJECTION === 'true'
      const binaryPath = useWrapper && (global as any).binaryWrapperPath 
        ? (global as any).binaryWrapperPath 
        : CONFIG.BINARY_PATH
      
      // Start the binary process
      processState.process = await startBinaryProcess(binaryPath, logger, useWrapper)
      
      if (!processState.process.pid) {
        throw new BinaryStartError('Failed to obtain process PID')
      }
      
      logger.info(`Binary started with PID: ${processState.process.pid}`)
      
      // Set up log monitoring
      monitorProcessLogs(processState.process, logger)
      
      // Handle process exit
      processState.process.on('exit', (code, signal) => {
        logger.error(`Binary process exited with code ${code} and signal ${signal}`)
        processState.isHealthy = false
        
        // Attempt restart if within limits
        if (processState.restartCount < CONFIG.MAX_RESTART_ATTEMPTS) {
          processState.restartCount++
          logger.info(`Attempting restart ${processState.restartCount}/${CONFIG.MAX_RESTART_ATTEMPTS}`)
          
          // Use exponential backoff for restarts
          const backoffDelay = calculateBackoff(processState.restartCount - 1, CONFIG.RESTART_DELAY)
          processState.metrics.lastRestartTime = Date.now()
          
          setTimeout(async () => {
            try {
              processState.process = await startBinaryProcess(binaryPath, logger, useWrapper)
              monitorProcessLogs(processState.process!, logger)
              processState.startTime = Date.now()
              processState.healthCache = null // Clear cache on restart
            } catch (error) {
              logger.error(`Failed to restart binary: ${error}`)
            }
          }, backoffDelay)
        } else {
          logger.error('Maximum restart attempts reached. Manual intervention required.')
        }
      })
      
      // Wait for initial startup
      await delay(CONFIG.STARTUP_GRACE_PERIOD)
      
      // Perform initial health check
      const health = await checkBinaryHealth(logger)
      processState.isHealthy = health.isRunning && (health.uptimeIncreasing || health.uptime > 0)
      
      logger.info(`Binary startup completed. Initial health: ${processState.isHealthy}`)
      
    } catch (error) {
      logger.error(`Failed to start binary: ${error}`)
      throw error
    }
  },

  health: async ({ logger, utils }: HookContext) => {
    try {
      // Perform comprehensive health check
      const metrics = await checkBinaryHealth(logger)
      
      // Determine overall health status
      const isHealthy = metrics.isRunning && 
                       !metrics.hasErrors && 
                       (metrics.uptimeIncreasing || metrics.uptime > 0)
      
      // Update state
      processState.isHealthy = isHealthy
      
      // Log health status with details and performance metrics
      logger.info(`Health check completed - healthy: ${isHealthy}, uptime: ${metrics.uptime}s, running: ${metrics.isRunning}, uptimeIncreasing: ${metrics.uptimeIncreasing}, hasErrors: ${metrics.hasErrors}, restartCount: ${processState.restartCount}, avgHealthCheckDuration: ${processState.metrics.avgHealthCheckDuration.toFixed(2)}ms, memoryUsage: ${(processState.metrics.memoryUsage / 1024 / 1024).toFixed(2)}MB`)
      
      // Return health status
      return isHealthy
    } catch (error) {
      logger.error(`Health check failed: ${error}`)
      return false
    }
  },

  stop: async ({ logger, utils }: HookContext) => {
    logger.info('Stopping binary service')
    
    try {
      if (!processState.process) {
        logger.warn('No process to stop')
        return
      }
      
      // Send graceful shutdown signal
      processState.process.kill('SIGTERM')
      logger.info('Sent SIGTERM to binary process')
      
      // Wait for graceful shutdown
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
      
      // Force kill if still running
      if (!shutdownComplete && processState.process.pid) {
        logger.warn('Graceful shutdown timeout, forcing kill')
        processState.process.kill('SIGKILL')
      }
      
      // Clean up wrapper script if exists
      if ((global as any).binaryWrapperPath && (global as any).binaryWrapperPath !== CONFIG.BINARY_PATH) {
        try {
          await fs.unlink((global as any).binaryWrapperPath)
          logger.info('Cleaned up binary wrapper')
        } catch (error) {
          logger.warn(`Failed to clean up wrapper: ${error}`)
        }
      }
      
      // Reset state
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