const axios = require('axios');
const express = require('express');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

class ProcessManager {
    constructor() {
        this.processes = new Map(); // Store running processes
    }

    startProcess(processId, command, args = []) {
        if (this.processes.has(processId)) {
            throw new Error(`Process ${processId} is already running`);
        }

        // Ensure we're running a Python command
        const pythonCommand = process.platform === 'win32' ? 'python' : 'python3';
        
        // Build the full command with proper arguments
        const fullCommand = [command, ...args].join(' ');
        
        const pythonProcess = spawn(pythonCommand, ['-u', '-c', fullCommand], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, PYTHONUNBUFFERED: '1' }
        });

        // Store process information
        this.processes.set(processId, {
            process: pythonProcess,
            startTime: new Date(),
            command: fullCommand,
            output: [],  // Store output history
            isRunning: true
        });

        // Handle stdout with proper encoding and buffer handling
        pythonProcess.stdout.setEncoding('utf8');
        pythonProcess.stdout.on('data', (data) => {
            const output = data.toString().trim();
            if (output) {
                console.log(`[${processId}] ${output}`);
                // Store output in history (limit to last 1000 lines)
                const processInfo = this.processes.get(processId);
                processInfo.output.push(output);
                if (processInfo.output.length > 1000) {
                    processInfo.output.shift();
                }
            }
        });

        // Handle stderr
        pythonProcess.stderr.setEncoding('utf8');
        pythonProcess.stderr.on('data', (data) => {
            const error = data.toString().trim();
            if (error) {
                console.error(`[${processId}] Error: ${error}`);
                const processInfo = this.processes.get(processId);
                processInfo.output.push(`ERROR: ${error}`);
            }
        });

        // Handle process completion
        pythonProcess.on('close', (code) => {
            console.log(`[${processId}] Python process exited with code ${code}`);
            const processInfo = this.processes.get(processId);
            if (processInfo) {
                processInfo.isRunning = false;
                processInfo.exitCode = code;
            }
        });

        return { 
            processId, 
            status: 'started',
            message: 'Python process started successfully'
        };
    }

    stopProcess(processId) {
        const processInfo = this.processes.get(processId);
        if (!processInfo) {
            throw new Error(`Process ${processId} not found`);
        }

        processInfo.process.kill();
        this.processes.delete(processId);
        return { processId, status: 'stopped' };
    }

    getProcessStatus(processId) {
        const processInfo = this.processes.get(processId);
        if (!processInfo) {
            return { processId, status: 'not_found' };
        }
        return {
            processId,
            status: 'running',
            startTime: processInfo.startTime,
            command: processInfo.command
        };
    }

    getAllProcesses() {
        const processes = [];
        for (const [processId, info] of this.processes) {
            processes.push({
                processId,
                status: 'running',
                startTime: info.startTime,
                command: info.command
            });
        }
        return processes;
    }
}

class InstanceAgent {
    constructor(serverUrl, port = 3001) {
        this.serverUrl = serverUrl;
        this.port = port;
        this.instanceIdFile = path.join(__dirname, '.instance-id');
        this.instanceId = this.getOrCreateInstanceId();
        this.processManager = new ProcessManager();
        this.app = express();
        this.setupEndpoints();
    }

    setupEndpoints() {
        this.app.use(express.json());

        // Command endpoint to start/stop processes
        this.app.post('/command', (req, res) => {
            const { action, processId, command, args } = req.body;

            try {
                switch (action) {
                    case 'start':
                        if (!processId || !command) {
                            return res.status(400).json({
                                status: 'error',
                                message: 'processId and command are required'
                            });
                        }
                        const result = this.processManager.startProcess(processId, command, args);
                        res.json({ status: 'success', ...result });
                        break;

                    case 'stop':
                        if (!processId) {
                            return res.status(400).json({
                                status: 'error',
                                message: 'processId is required'
                            });
                        }
                        const stopResult = this.processManager.stopProcess(processId);
                        res.json({ status: 'success', ...stopResult });
                        break;

                    case 'status':
                        if (processId) {
                            const status = this.processManager.getProcessStatus(processId);
                            res.json({ status: 'success', process: status });
                        } else {
                            const processes = this.processManager.getAllProcesses();
                            res.json({ status: 'success', processes });
                        }
                        break;


                    case 'list':
                        // Get all processes and their details
                        const allProcesses = this.processManager.getAllProcesses();
                        res.json({ 
                            status: 'success', 
                            processes: allProcesses,
                            count: allProcesses.length
                        });
                        break;

                    default:
                        res.status(400).json({
                            status: 'error',
                            message: 'Invalid action'
                        });
                }
            } catch (error) {
                res.status(500).json({
                    status: 'error',
                    message: error.message
                });
            }
        });
    }

    getOrCreateInstanceId() {
        try {
            if (fs.existsSync(this.instanceIdFile)) {
                return fs.readFileSync(this.instanceIdFile, 'utf8');
            }
            
            const newInstanceId = uuidv4();
            fs.writeFileSync(this.instanceIdFile, newInstanceId);
            return newInstanceId;
        } catch (error) {
            console.error('Error managing instance ID:', error);
            return uuidv4();
        }
    }

    async connect() {
        try {
            const response = await axios.post(`${this.serverUrl}/connect`, {
                instanceId: this.instanceId,
                region: process.env.AWS_REGION || 'unknown'
            });

            console.log('Successfully connected to server:', response.data);
            return response.data;
        } catch (error) {
            console.error('Failed to connect to server:', error.message);
            throw error;
        }
    }

    async updateMetrics(rps, gps) {
        try {
            const response = await axios.post(`${this.serverUrl}/update`, {
                instanceId: this.instanceId,
                rps,
                gps
            });

            console.log('Successfully updated metrics:', response.data);
            return response.data;
        } catch (error) {
            console.error('Failed to update metrics:', error.message);
            throw error;
        }
    }

    setupCleanup() {
        const cleanup = async () => {
            try {
                console.log('Agent shutting down...');
                // Stop all running processes
                for (const [processId] of this.processManager.processes) {
                    this.processManager.stopProcess(processId);
                }
                process.exit(0);
            } catch (error) {
                console.error('Error during cleanup:', error);
                process.exit(1);
            }
        };

        process.on('SIGTERM', cleanup);
        process.on('SIGINT', cleanup);
    }

    async run() {
        try {
            // Start the command endpoint server
            this.app.listen(this.port, () => {
                console.log(`Agent command endpoint listening on port ${this.port}`);
            });

            // Initial connection to main server
            await this.connect();
            
            // Setup cleanup handlers
            this.setupCleanup();

            console.log('Agent running with instance ID:', this.instanceId);

            // Example: Update metrics every minute
            setInterval(async () => {
                const rps = Math.floor(Math.random() * 100);
                const gps = Math.floor(Math.random() * 50);
                await this.updateMetrics(rps, gps);
            }, 60000);

        } catch (error) {
            console.error('Error running agent:', error);
            process.exit(1);
        }
    }
}

// Create and run the agent
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';
const AGENT_PORT = process.env.AGENT_PORT || 3001;
const agent = new InstanceAgent(SERVER_URL, AGENT_PORT);
agent.run();