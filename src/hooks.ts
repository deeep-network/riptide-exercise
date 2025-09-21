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
} as const

// =============================================================================
// TYPES - TypeScript interfaces and types
// =============================================================================
interface ProcessState {
  process: ChildProcess | null
  startTime: number
  lastUptime: number
  isHealthy: boolean
  restartCount: number
  logs: string[]
}

interface HealthMetrics {
  uptime: number
  isRunning: boolean
  hasErrors: boolean
  uptimeIncreasing: boolean
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
const extractUptimeFromLogs = (logs: string[]): number => {
  const uptimePatterns = [
    /uptime[:\s]+(\d+(?:\.\d+)?)\s*(?:seconds?|s)/i,
    /running\s+for[:\s]+(\d+(?:\.\d+)?)\s*(?:seconds?|s)/i,
    /alive[:\s]+(\d+(?:\.\d+)?)\s*(?:seconds?|s)/i,
  ]
  
  for (let i = logs.length - 1; i >= 0; i--) {
    for (const pattern of uptimePatterns) {
      const match = logs[i].match(pattern)
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
  logs: []
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

const monitorProcessLogs = (process: ChildProcess, logger: any): void => {
  // Clear previous logs
  processState.logs = []
  
  // Monitor stdout
  const stdoutReader = createInterface({
    input: process.stdout!,
    crlfDelay: Infinity
  })
  
  stdoutReader.on('line', (line) => {
    logger.debug(`[BINARY STDOUT] ${line}`)
    processState.logs.push(line)
    
    // Keep only last CONFIG.MAX_LOG_LINES to prevent memory issues
    if (processState.logs.length > CONFIG.MAX_LOG_LINES) {
      processState.logs.shift()
    }
  })
  
  // Monitor stderr
  const stderrReader = createInterface({
    input: process.stderr!,
    crlfDelay: Infinity
  })
  
  stderrReader.on('line', (line) => {
    logger.warn(`[BINARY STDERR] ${line}`)
    processState.logs.push(`ERROR: ${line}`)
    
    // Check for invalid secret error
    if (line.toLowerCase().includes('invalid') && line.toLowerCase().includes('secret')) {
      logger.error('Invalid secret detected in binary output')
      process.kill('SIGTERM')
    }
  })
}

const checkBinaryHealth = async (logger: any): Promise<HealthMetrics> => {
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
  
  // Check for errors in recent logs
  const recentLogs = processState.logs.slice(-50)
  metrics.hasErrors = recentLogs.some(log => 
    log.toLowerCase().includes('error') || 
    log.toLowerCase().includes('exception') ||
    log.toLowerCase().includes('failed')
  )
  
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
          
          setTimeout(async () => {
            try {
              processState.process = await startBinaryProcess(binaryPath, logger, useWrapper)
              monitorProcessLogs(processState.process!, logger)
            } catch (error) {
              logger.error(`Failed to restart binary: ${error}`)
            }
          }, CONFIG.RESTART_DELAY)
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
      
      // Log health status with details
      logger.info(`Health check completed - healthy: ${isHealthy}, uptime: ${metrics.uptime}s, running: ${metrics.isRunning}, uptimeIncreasing: ${metrics.uptimeIncreasing}, hasErrors: ${metrics.hasErrors}, restartCount: ${processState.restartCount}`)
      
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
      processState.logs = []
      
      logger.info('Binary service stopped successfully')
    } catch (error) {
      logger.error(`Error during shutdown: ${error}`)
      throw error
    }
  }
}