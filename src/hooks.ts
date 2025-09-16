import type { HookContext } from '@deeep-network/riptide'
import { spawn, ChildProcess } from 'child_process'
import { MissingSecretError, InvalidSecretError } from '@deeep-network/riptide'

let serviceProcess: ChildProcess | null = null
module.exports = {
  installSecrets: async ({ env, logger }: HookContext) => {
    // Install Secrets - check for secrets and set / install them
    return { success: true }
  },

  start: async ({ env, logger }: HookContext) => {
    // Start The Binary
  },

  health: async ({ logger, utils }: HookContext) => {

    // Return True if healthy 
    return true
  },

  stop: async ({ logger, utils }: HookContext) => {
    //Shutdown the process
  }
}
