#!/bin/bash

# Quick Start Script for Binary Management Service
# This script helps you quickly build and run the service

set -e

echo "Binary Management Service - Quick Start"
echo "========================================="
echo ""

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "Docker is not installed. Please install Docker first."
    exit 1
fi

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "npm is not installed. Please install Node.js and npm first."
    exit 1
fi

echo "Installing dependencies..."
npm install

echo ""
echo "Building the project..."
npm run build

echo ""
echo "Building Docker image..."
npm run build:docker

echo ""
echo "Build complete!"
echo ""
echo "Available run options:"
echo ""
echo "1. Run with default configuration:"
echo "   docker run -it reef-homework"
echo ""
echo "2. Run with auto key injection (bonus feature):"
echo "   docker run -it -e AUTO_KEY_INJECTION=true reef-homework"
echo ""
echo "3. Run with custom configuration:"
echo "   docker run -it \\"
echo "     -e HEALTH_CHECK_INTERVAL=2000 \\"
echo "     -e MAX_RESTART_ATTEMPTS=5 \\"
echo "     -e ENABLE_METRICS=true \\"
echo "     reef-homework"
echo ""
echo "4. Run with debug logging:"
echo "   docker run -it -e LOG_LEVEL=debug reef-homework"
echo ""
echo "Happy to see you!"


