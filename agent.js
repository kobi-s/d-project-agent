const axios = require('axios');
const express = require('express');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

class ProcessManager {
    constructor() {
        this.campaign = null; 
        this.processes = new Map(); 
        this.outputBuffer = new Map(); 
    }

    startProcess(processId, command, args = [], campaign) {
        if (this.processes.has(processId)) {
            throw new Error(`Process ${processId} is already running`);
        }
            
        this.campaign = campaign;
        // Build the full command
        const fullCommand = [command, ...args].join(' ');
        
        // Use bash explicitly to run the command
        const childProcess = spawn('/bin/bash', ['-c', fullCommand], {
            stdio: ['pipe', 'pipe', 'pipe']
        });
    
        // Initialize output buffer for this process
        this.outputBuffer.set(processId, []);
    
        this.processes.set(processId, {
            process: childProcess,
            startTime: new Date(),
            command: fullCommand,
            output: [],  // Store output history
            isRunning: true
        });
    
        // Rest of the function remains the same...
        childProcess.stdout.setEncoding('utf8');
        childProcess.stdout.on('data', (data) => {
            const output = data.toString().trim();
            if (output) {
                console.log(`[${processId}] ${output}`);
                const buffer = this.outputBuffer.get(processId);
                buffer.push(output);
            }
        });
    
        childProcess.stderr.setEncoding('utf8');
        childProcess.stderr.on('data', (data) => {
            const error = data.toString().trim();
            if (error) {
                console.error(`[${processId}] Error: ${error}`);
                const buffer = this.outputBuffer.get(processId);
                buffer.push(`ERROR: ${error}`);
            }
        });
    
        childProcess.on('close', (code) => {
            console.log(`[${processId}] Process exited with code ${code}`);
            const processInfo = this.processes.get(processId);
            if (processInfo) {
                processInfo.isRunning = false;
                processInfo.exitCode = code;
            }
        });
    
        return { 
            processId, 
            status: 'started',
            message: 'Process started successfully'
        };
    }

    stopProcess(processId) {
        const processInfo = this.processes.get(processId);
        if (!processInfo) {
            throw new Error(`Process ${processId} not found`);
        }

        processInfo.process.kill();
        this.processes.delete(processId);
        this.campaign = null;
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

    getAllProcessOutputs() {
        const outputs = {};
        for (const [processId, info] of this.processes) {
            const bufferedOutput = this.outputBuffer.get(processId) || [];
            
            info.output = [...info.output, ...bufferedOutput];
            
            // Keep only last 1000 lines in history
            if (info.output.length > 1000) {
                info.output = info.output.slice(info.output.length - 1000);
            }
            
            outputs[processId] = {
                output: bufferedOutput, // Send only new output since last update
                isRunning: info.isRunning,
                exitCode: info.exitCode,
                command: info.command,
                startTime: info.startTime
            };
            
            // Clear buffer after adding to outputs
            this.outputBuffer.set(processId, []);
        }
        return outputs;
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
            const { action, processId, command, args, campaign } = req.body;

            try {
                switch (action) {
                    case 'start':
                        if (!processId || !command) {
                            return res.status(400).json({
                                status: 'error',
                                message: 'processId and command are required'
                            });
                        }
                        
                        const result = this.processManager.startProcess(processId, command, args, campaign);
                        this.processManager.campaign = campaign;

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

        this.app.get('/health', (req, res) => {
            return res.sendStatus(200)
        })
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
            const processOutputs = this.processManager.getAllProcessOutputs();
            const response = await axios.post(`${this.serverUrl}/update`, {
                instanceId: this.instanceId,
                rps,
                gps,
                processes: processOutputs,
                campaign: this.processManager.campaign
            });
    
            console.log('Successfully updated metrics and process outputs:', response.data);
            return response.data;
        } catch (error) {
            console.error('Failed to update metrics and process outputs:', error.message);
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
    
            // Update metrics and process outputs every 10 seconds
            // setInterval(async () => {
            //     const rps = Math.floor(Math.random() * 100);
            //     const gps = Math.floor(Math.random() * 50);
            //     await this.updateMetrics(rps, gps);
            // }, 10000);
    
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