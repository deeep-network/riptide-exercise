import type { HookContext } from '@deeep-network/riptide'
import { spawn, ChildProcess } from 'child_process'
import { MissingSecretError, InvalidSecretError } from '@deeep-network/riptide'

let serviceProcess: ChildProcess | null = null
let lastUptimeValue = 0
let uptimeCheckCount = 0
let isHealthy = true
let lastUptimeTimestamp = Date.now()
let noUptimeTimeout = 10000 // timeout for uptime updates

module.exports = {
  installSecrets: async ({ env, logger }: HookContext) => {
    logger.info('Installing secrets for binary...')

    // Try environment variable approach first
    const secretKey = env.SECRET_KEY || 'DEEEP_NETWORK'

    try {
      // Set key via environment variable instead of command line
      logger.info('Setting key via environment variable...')

      logger.info(`Using secret key from environment: ${secretKey}`)
      return { success: true }

    } catch (error) {
      logger.error(`Error during secret installation: ${error}`)

      // Fallback to command line method
      logger.info('Falling back to --key command...')

      const keyProcess = spawn('/app/binary', [`--key=${secretKey}`], {
        cwd: '/app',
        stdio: ['pipe', 'pipe', 'pipe']
      })

      return new Promise((resolve, reject) => {
        let output = ''
        let errorOutput = ''

        keyProcess.stdout?.on('data', (data) => {
          output += data.toString()
          logger.info(`Key setup output: ${data.toString().trim()}`)
        })

        keyProcess.stderr?.on('data', (data) => {
          errorOutput += data.toString()
          logger.error(`Key setup error: ${data.toString().trim()}`)
        })

        keyProcess.on('close', (code) => {
          if (code === 0) {
            logger.info('Secret key installed successfully')
            resolve({ success: true })
          } else {
            logger.error(`Failed to install secret key, exit code: ${code}`)
            if (errorOutput.includes('invalid secret') || errorOutput.includes('wrong')) {
              reject(new InvalidSecretError('Invalid secret key provided'))
            } else {
              reject(new Error(`Key installation failed with code ${code}: ${errorOutput}`))
            }
          }
        })

        keyProcess.on('error', (error) => {
          logger.error(`Key installation process error: ${error.message}`)
          reject(error)
        })
      })
    }
  },

  start: async ({ env, logger }: HookContext) => {
    logger.info('Starting the binary...')

    if (serviceProcess) {
      logger.warn('Binary process already running, stopping it first')
      serviceProcess.kill('SIGTERM')
      serviceProcess = null
    }

    try {
      // Pass secret key via environment variables
      const secretKey = env.SECRET_KEY || 'DEEEP_NETWORK'
      const binaryEnv = {
        ...process.env,
        SECRET_KEY: secretKey,
        KEY: secretKey
      }

      logger.info('Starting binary with env vars...')

      serviceProcess = spawn('/app/binary', ['start'], {
        cwd: '/app',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: binaryEnv
      })

      serviceProcess.stdout?.on('data', (data) => {
        const output = data.toString().trim()
        logger.info(`Binary output: ${output}`)

        // Parse uptime from binary output
        const uptimeMatch = output.match(/uptime[:\s]+(\d{2}):(\d{2}):(\d{2})/i)
        if (uptimeMatch) {
          const hours = parseInt(uptimeMatch[1])
          const minutes = parseInt(uptimeMatch[2])
          const seconds = parseInt(uptimeMatch[3])
          const currentUptime = hours * 3600 + minutes * 60 + seconds
          logger.info(`Current uptime: ${currentUptime}s (${uptimeMatch[1]}:${uptimeMatch[2]}:${uptimeMatch[3]})`)

          // Track uptime changes
          if (currentUptime > lastUptimeValue) {
            lastUptimeValue = currentUptime
            lastUptimeTimestamp = Date.now()
            uptimeCheckCount = 0
            isHealthy = true
          } else {
            uptimeCheckCount++
            if (uptimeCheckCount >= 3) {
              logger.warn('Uptime not increasing, marking as unhealthy')
              isHealthy = false
            }
          }
        }
      })

      serviceProcess.stderr?.on('data', (data) => {
        logger.error(`Binary error: ${data.toString().trim()}`)
      })

      serviceProcess.on('close', (code) => {
        logger.warn(`Binary process exited with code: ${code}`)
        isHealthy = false
        serviceProcess = null
      })

      serviceProcess.on('error', (error) => {
        logger.error(`Binary process error: ${error.message}`)
        isHealthy = false
        serviceProcess = null
      })

      logger.info('Binary started successfully')
    } catch (error) {
      logger.error(`Failed to start binary: ${error}`)
      throw error
    }
  },

  health: async ({ logger, utils }: HookContext) => {
    // Check process status and health
    if (!serviceProcess) {
      logger.warn('Health check: Binary process not running')
      return false
    }

    // Check for stalled uptime
    const timeSinceLastUptime = Date.now() - lastUptimeTimestamp
    if (timeSinceLastUptime > noUptimeTimeout) {
      logger.warn(`Health check: No uptime updates for ${Math.floor(timeSinceLastUptime / 1000)}s, marking unhealthy`)
      isHealthy = false
      return false
    }

    if (!isHealthy) {
      logger.warn('Health check: Binary marked as unhealthy')
      return false
    }

    logger.info(`Health check: Binary is healthy (uptime: ${lastUptimeValue}s)`)
    return true
  },

  heartbeat: async ({ logger, utils }: HookContext) => {
    // Run health check
    const isCurrentlyHealthy = await module.exports.health({ logger, utils })

    if (!isCurrentlyHealthy) {
      logger.error('Heartbeat: Service is unhealthy!')
    } else {
      logger.info(`Heartbeat: Service is healthy (uptime: ${lastUptimeValue}s)`)
    }

    return isCurrentlyHealthy
  },

  stop: async ({ logger, utils }: HookContext) => {
    logger.info('Stopping the binary...')

    if (serviceProcess) {
      try {
        // Try graceful shutdown first
        serviceProcess.kill('SIGTERM')

        // Wait for graceful shutdown
        await new Promise(resolve => setTimeout(resolve, 2000))

        // Force kill if still running
        if (serviceProcess && !serviceProcess.killed) {
          logger.warn('Force killing binary process')
          serviceProcess.kill('SIGKILL')
        }

        serviceProcess = null
        isHealthy = false
        lastUptimeValue = 0
        uptimeCheckCount = 0
        lastUptimeTimestamp = Date.now()

        logger.info('Binary stopped successfully')
      } catch (error) {
        logger.error(`Error stopping binary: ${error}`)
        throw error
      }
    } else {
      logger.info('Binary was not running')
    }
  }
}
