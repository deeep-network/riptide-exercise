## Tasks 

Tasks are defined in [./todo.md](./todo.md) file  

# Riptide And Hooks Docs 


Please refer to this 
https://www.npmjs.com/package/@deeep-network/riptide



# Binary Instructions

This document provides instructions for running the binary application and handling various scenarios.

binary is made only for linux/amd64

## Usage

### Setting the Key
To set the key, run:
```bash
./binary --key="DEEEP_NETWORK"
```

### Starting the Node
To start the node, run:
```bash
./binary start
```

## Error Scenarios ( Binary )

The following scenarios may occur when running the binary and need to be handled:

1. **Invalid Key Error**: If the key is wrong, you will see an error (throw invalid secret when running)
2. **Binary Exit Error**: There is a 33% chance that the binary will exit with an error (fail healthcheck)
3. **Uptime Not Increasing**: There is a 33% chance that the binary will start but uptime will not increase (fail healthcheck)
4. **Normal Operation**: The binary will run fine and uptime will increase (track uptime in seconds and log it)

## Environment Configuration

> **Note**: Please add an environment variable when running the container so we can change it dynamically.

---
There is some boilerplate code in hooks.ts where you need to manage all the functionality of the binary.



Feel Free To Ask Questions

**Best Of Luck**