# Manual Testing Guide for Optimized Binary Management Service

## Quick Start Testing

### 1. Build and Run (Easiest Method)
```bash
# Run the quick start script
./QUICK_START.sh

# Then run with default settings
docker run -it reef-homework
```

### 2. Step-by-Step Manual Build
```bash
# Install dependencies
npm install

# Build the project
npm run build

# Build Docker image
npm run build:docker

# Run the container
docker run -it reef-homework
```

## Testing Different Scenarios

### 3. Test Basic Functionality
```bash
# Run with default configuration
docker run -it reef-homework
```
**Expected behavior:**
- Service starts
- Binary gets key set with "DEEEP_NETWORK"
- Binary starts running
- Health checks begin
- You'll see logs showing uptime tracking

### 4. Test Auto Key Injection (Bonus Feature)
```bash
# Test the wrapper script feature
docker run -it -e AUTO_KEY_INJECTION=true reef-homework
```
**Expected behavior:**
- Wrapper script is created
- Binary runs without manual key setting
- Same functionality as default but using wrapper

### 5. Test Performance Optimizations
```bash
# Run with metrics enabled and debug logging
docker run -it \
  -e ENABLE_METRICS=true \
  -e LOG_LEVEL=debug \
  -e HEALTH_CHECK_INTERVAL=1000 \
  reef-homework
```
**Expected behavior:**
- Debug logs show detailed performance metrics
- Health check duration tracking
- Memory usage monitoring
- Log processing time metrics

### 6. Test Custom Configuration
```bash
# Test with custom settings
docker run -it \
  -e HEALTH_CHECK_INTERVAL=2000 \
  -e MAX_RESTART_ATTEMPTS=5 \
  -e STARTUP_GRACE_PERIOD=3000 \
  -e HEALTH_CACHE_TTL=1000 \
  -e MAX_LOG_LINES=500 \
  reef-homework
```

### 7. Test Error Scenarios
```bash
# Run with invalid secret to test error handling
docker run -it -e BINARY_SECRET_KEY=WRONG_KEY reef-homework
```
**Expected behavior:**
- Service detects invalid secret
- Attempts restart with exponential backoff
- Eventually fails after max attempts

## What to Look For During Testing

### ✅ Success Indicators

1. **Startup Sequence:**
   ```
   [INFO] Installing secrets for binary management
   [INFO] Binary found and is executable
   [INFO] Starting binary service
   [INFO] Binary key set successfully
   [INFO] Binary started with PID: XXXX
   ```

2. **Health Check Logs:**
   ```
   [INFO] Health check completed - healthy: true, uptime: X.Xs, running: true, uptimeIncreasing: true, hasErrors: false, restartCount: 0, avgHealthCheckDuration: X.XXms, memoryUsage: X.XXMB
   ```

3. **Performance Metrics (with ENABLE_METRICS=true):**
   - Average health check duration should be low (< 5ms)
   - Memory usage should be stable
   - Log processing time should be minimal

### 🚨 What to Watch For

1. **Binary Behavior (33% chance scenarios):**
   - **Normal**: Uptime increases steadily
   - **Exit Error**: Binary exits, service attempts restart
   - **Uptime Stuck**: Binary runs but uptime doesn't increase

2. **Restart Logic:**
   - Exponential backoff delays
   - Maximum restart attempts respected
   - State reset on restart

3. **Memory Optimization:**
   - Log buffer doesn't grow unbounded
   - Memory usage stays stable over time

## Advanced Testing

### 8. Test Log Buffer Optimization
```bash
# Run with small log buffer to test circular buffer
docker run -it \
  -e MAX_LOG_LINES=50 \
  -e LOG_LEVEL=debug \
  reef-homework
```
**Check:** Logs should be limited to 50 entries max

### 9. Test Health Check Caching
```bash
# Run with very short cache TTL
docker run -it \
  -e HEALTH_CACHE_TTL=100 \
  -e HEALTH_CHECK_INTERVAL=500 \
  -e LOG_LEVEL=debug \
  reef-homework
```
**Check:** Health checks should use cache when appropriate

### 10. Stress Test Restarts
```bash
# Run with aggressive restart settings
docker run -it \
  -e MAX_RESTART_ATTEMPTS=10 \
  -e RESTART_DELAY=500 \
  reef-homework
```

## Interactive Testing Commands

### Inside Running Container
If you want to inspect the running container:

```bash
# Run container in background
docker run -d --name test-service reef-homework

# Execute commands inside
docker exec -it test-service /bin/bash

# Check process status
ps aux | grep binary

# Check logs
tail -f /app/logs/* (if any log files exist)

# Stop the test
docker stop test-service && docker rm test-service
```

## Debugging Tips

### View Container Logs
```bash
# Run in background and follow logs
docker run -d --name debug-test reef-homework
docker logs -f debug-test
```

### Test with Different Node.js Versions
```bash
# The Dockerfile uses Node 22, but you can test locally with different versions
nvm use 18  # or any version >= 22
npm run build
npm run start
```

### Performance Profiling
```bash
# Run with Node.js profiling
docker run -it \
  -e NODE_OPTIONS="--inspect=0.0.0.0:9229" \
  -p 9229:9229 \
  reef-homework
```

## Expected Test Results

### Normal Operation
- Service starts successfully
- Health checks pass consistently
- Binary uptime increases over time
- Memory usage remains stable
- Performance metrics show optimization benefits

### Error Recovery
- Invalid secrets are detected
- Restart attempts use exponential backoff
- Maximum restart limits are respected
- Service fails gracefully when limits exceeded

### Performance Improvements
- Health check duration: < 5ms average
- Memory usage: Stable, no memory leaks
- Log processing: Minimal overhead
- Startup time: Faster than unoptimized version

## Troubleshooting

### Common Issues
1. **Docker not found**: Install Docker
2. **Permission denied**: Check binary permissions in container
3. **Port conflicts**: Use different ports if needed
4. **Build failures**: Check Node.js version compatibility

### Log Analysis
Look for these patterns:
- `[ERROR]` messages indicate problems
- `[WARN]` messages show recoverable issues  
- `[INFO]` messages show normal operation
- `[DEBUG]` messages show detailed internal state

The optimized service should show improved performance metrics and more stable operation compared to the original implementation.
