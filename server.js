const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const FormData = require('form-data');
const { spawn } = require('child_process');
const net = require('net');

// ============ CONFIGURARE ============
const CONFIG_FILE = path.join('workflows', 'config.json');
let CONFIG = {
    ADMIN_PORT: parseInt(process.env.ADMIN_PORT) || 3001,
    PUBLIC_PORT: parseInt(process.env.PUBLIC_PORT) || 3002,
    COMFYUI_URLS: process.env.COMFYUI_URLS ? process.env.COMFYUI_URLS.split(',') : [process.env.COMFYUI_URL || 'http://127.0.0.1:8188']
};

// Încărcăm configurația salvată dacă există
if (fs.existsSync(CONFIG_FILE)) {
    try {
        const savedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

        // Migrare robustă de la COMFYUI_URL (string) la COMFYUI_URLS (array)
        if (savedConfig.COMFYUI_URL) {
            if (!savedConfig.COMFYUI_URLS || !Array.isArray(savedConfig.COMFYUI_URLS) || savedConfig.COMFYUI_URLS.length === 0) {
                savedConfig.COMFYUI_URLS = [savedConfig.COMFYUI_URL];
            } else if (!savedConfig.COMFYUI_URLS.includes(savedConfig.COMFYUI_URL)) {
                // If both exist but the old one isn't in the new list, add it to the front
                savedConfig.COMFYUI_URLS.unshift(savedConfig.COMFYUI_URL);
            }
        }

        // Asigurăm formatul corect pentru COMFYUI_URLS
        if (savedConfig.COMFYUI_URLS && typeof savedConfig.COMFYUI_URLS === 'string') {
            savedConfig.COMFYUI_URLS = savedConfig.COMFYUI_URLS.split(',').map(s => s.trim());
        }

        CONFIG = { ...CONFIG, ...savedConfig };
    } catch (e) {
        console.error('Error loading config.json:', e.message);
    }
}

// Curățăm cheia veche dacă a rămas
if (CONFIG.COMFYUI_URL) delete CONFIG.COMFYUI_URL;

let ADMIN_PORT = CONFIG.ADMIN_PORT;
let PUBLIC_PORT = CONFIG.PUBLIC_PORT;
let COMFYUI_URLS = CONFIG.COMFYUI_URLS;

// Fallback de siguranță
if (!Array.isArray(COMFYUI_URLS) || COMFYUI_URLS.length === 0) {
    COMFYUI_URLS = ['http://127.0.0.1:8188'];
}

// Funcție pentru a găsi un port liber
async function findFreePort(startPort) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.on('error', () => {
            resolve(findFreePort(startPort + 1));
        });
        server.listen(startPort, '0.0.0.0', () => {
            const { port } = server.address();
            server.close(() => {
                resolve(port);
            });
        });
    });
}

// Configurare upload
const upload = multer({ 
    dest: 'uploads/', 
    limits: { fileSize: 1024 * 1024 * 1024 }
});

// Asigură existența directoarelor
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('output')) fs.mkdirSync('output');
if (!fs.existsSync('workflows')) fs.mkdirSync('workflows');
if (!fs.existsSync('workflows/saved')) fs.mkdirSync('workflows/saved');

// Store pentru workflow-ul curent
let currentWorkflowData = null;
let currentWorkflowId = null; // ID-ul workflow-ului salvat curent
let uiConfig = null;
let originalWorkflowValues = {}; // Stochează valorile originale din workflow


async function getFreestInstance() {
    const instances = COMFYUI_URLS;
    if (instances.length === 1) return instances[0];

    const stats = await Promise.all(instances.map(async (url) => {
        try {
            const res = await fetch(`${url}/queue`, { timeout: 2000 });
            if (!res.ok) return { url, load: Infinity };
            const data = await res.json();
            // Load = running + pending
            const load = (data.queue_running ? data.queue_running.length : 0) +
                         (data.queue_pending ? data.queue_pending.length : 0);
            return { url, load };
        } catch (e) {
            return { url, load: Infinity };
        }
    }));

    const sorted = stats.sort((a, b) => a.load - b.load);
    if (sorted[0].load === Infinity) {
        throw new Error('Nicio instanță ComfyUI nu este disponibilă');
    }
    return sorted[0].url;
}

async function uploadFileToInstance(instanceUrl, filePath, originalName, mimetype) {
    const formData = new FormData();
    formData.append('image', fs.createReadStream(filePath), {
        filename: originalName,
        contentType: mimetype
    });
    
    const res = await fetch(`${instanceUrl}/upload/image`, {
        method: 'POST',
        body: formData,
        headers: formData.getHeaders()
    });
    
    if (!res.ok) throw new Error(`Upload failed to ${instanceUrl}: ${res.status}`);
    return await res.json();
}

function generateId() {
    return Date.now().toString() + '-' + Math.random().toString(36).substr(2, 9);
}

function generateRandomSeed() {
    return Math.floor(Math.random() * 1000000000000);
}

function shouldGenerateRandomSeed(paramKey, paramValue, autoRandomFlags) {
    if (autoRandomFlags && autoRandomFlags[paramKey] === true) return true;
    if (autoRandomFlags && autoRandomFlags['_global'] === true) return true;
    if (paramValue === 'random' || paramValue === '' || paramValue === null) return true;
    return false;
}

// ============ EXTRAGE TOATE VALORILE ORIGINALE DIN WORKFLOW ============

function extractOriginalWorkflowValues(workflowApi) {
    const values = {};
    if (!workflowApi) return values;
    
    for (const [nodeId, node] of Object.entries(workflowApi)) {
        if (node.inputs) {
            for (const [inputName, inputValue] of Object.entries(node.inputs)) {
                // Ignoră link-uri către alte noduri
                if (inputValue && typeof inputValue === 'object' && (inputValue[0] || inputValue.hasOwnProperty('0'))) {
                    continue;
                }
                
                const key = `node_${nodeId}_${inputName}`;
                values[key] = inputValue;
            }
        }
    }
    
    return values;
}

// ============ LOGICĂ BYPASS ============

function applyBypass(workflow, bypassedNodes) {
    if (!bypassedNodes) return workflow;

    const nodesToBypass = Object.entries(bypassedNodes)
        .filter(([_, isBypassed]) => isBypassed)
        .map(([nodeId, _]) => nodeId);

    for (const nodeId of nodesToBypass) {
        if (!workflow[nodeId]) continue;

        const node = workflow[nodeId];
        const type = node.class_type || "";

        // Noduri de output - le ștergem pur și simplu
        if (type.includes('Save') || type.includes('Preview') || type.includes('Combine')) {
            console.log(`🗑️ Deleting output node ${nodeId} (${type})`);
            delete workflow[nodeId];
            continue;
        }

        // Noduri intermediare - încercăm să facem "bridge" (pod)
        // Căutăm prima intrare care este un link (un array)
        let sourceLink = null;
        if (node.inputs) {
            for (const inputVal of Object.values(node.inputs)) {
                if (Array.isArray(inputVal)) {
                    sourceLink = inputVal;
                    break;
                }
            }
        }

        if (sourceLink) {
            console.log(`🌉 Bridging node ${nodeId} (${type}) -> Source: Node ${sourceLink[0]}, Output ${sourceLink[1]}`);
        } else {
            console.log(`⚠️ Node ${nodeId} (${type}) has no source to bridge. Removing downstream links.`);
        }

        // Re-rutăm toate nodurile care depind de acest nod
        for (const otherNodeId in workflow) {
            const otherNode = workflow[otherNodeId];
            if (!otherNode.inputs) continue;

            for (const [inputName, inputVal] of Object.entries(otherNode.inputs)) {
                if (Array.isArray(inputVal) && String(inputVal[0]) === String(nodeId)) {
                    if (sourceLink) {
                        otherNode.inputs[inputName] = sourceLink;
                        console.log(`   - Updated node ${otherNodeId} (${otherNode.class_type}) input "${inputName}" to point to source node ${sourceLink[0]}`);
                    } else {
                        delete otherNode.inputs[inputName];
                        console.log(`   - Removed link from node ${otherNodeId} (${otherNode.class_type}) input "${inputName}"`);
                    }
                }
            }
        }

        console.log(`🔇 Bypassed node ${nodeId} (${type})`);
        delete workflow[nodeId];
    }

    return workflow;
}

// ============ VALIDARE PARAMETRI WORKFLOW ============

function validateWorkflowParameters(workflow, parameters) {
    const warnings = [];
    const MAX_FRAMES = 300;
    const MAX_WIDTH = 2048;
    const MAX_HEIGHT = 2048;
    const MIN_WIDTH = 64;
    const MIN_HEIGHT = 64;
    const MAX_BATCH_SIZE = 4;
    const MAX_STEPS = 100;
    const MIN_STEPS = 1;
    const MAX_CFG = 30;
    const MIN_CFG = 0.1;
    
    for (const [nodeId, node] of Object.entries(workflow)) {
        if (!node.inputs) continue;

        // Skip linked inputs (represented as arrays or special string formats like "170:167,0")
        const activeInputs = {};
        for (const [key, value] of Object.entries(node.inputs)) {
            const isLink = Array.isArray(value) || (typeof value === 'string' && value.includes(':') && value.includes(','));
            if (!isLink) {
                activeInputs[key] = value;
            }
        }
        
        // Detectează noduri video/generare
        const isVideoNode = node.class_type && (
            node.class_type.includes('LTX') ||
            node.class_type.includes('Video') ||
            node.class_type === 'VHS_VideoCombine' ||
            node.class_type === 'SaveVideo' ||
            node.class_type === 'SamplerCustom' ||
            node.class_type === 'KSampler' ||
            node.class_type === 'KSamplerAdvanced'
        );
        
        if (isVideoNode) {
            // Validează length/num_frames
            if (activeInputs.length !== undefined) {
                let length = parseFloat(activeInputs.length);
                if (isNaN(length) || length <= 0 || length > MAX_FRAMES) {
                    const oldValue = activeInputs.length;
                    node.inputs.length = 25;
                    warnings.push(`[${node.class_type}] Length invalid: ${oldValue} → setat la 25`);
                    console.warn(`⚠️ Length invalid în nodul ${nodeId}: ${oldValue} → setat la 25`);
                }
            }
            
            if (activeInputs.num_frames !== undefined) {
                let numFrames = parseFloat(activeInputs.num_frames);
                if (isNaN(numFrames) || numFrames <= 0 || numFrames > MAX_FRAMES) {
                    const oldValue = activeInputs.num_frames;
                    node.inputs.num_frames = 25;
                    warnings.push(`[${node.class_type}] Num_frames invalid: ${oldValue} → setat la 25`);
                    console.warn(`⚠️ Num_frames invalid în nodul ${nodeId}: ${oldValue} → setat la 25`);
                }
            }
            
            // Validează frame_rate - CRITIC: nu poate fi 0
            if (activeInputs.frame_rate !== undefined) {
                let frameRate = parseFloat(activeInputs.frame_rate);
                if (isNaN(frameRate) || frameRate <= 0) {
                    const oldValue = activeInputs.frame_rate;
                    node.inputs.frame_rate = 24; // Valoare implicită sigură
                    warnings.push(`[${node.class_type}] Frame_rate invalid: ${oldValue} → setat la 24`);
                    console.warn(`⚠️ Frame_rate invalid în nodul ${nodeId}: ${oldValue} → setat la 24`);
                }
            }
            
            // Validează width
            if (activeInputs.width !== undefined) {
                let width = parseInt(activeInputs.width);
                if (isNaN(width) || width < MIN_WIDTH || width > MAX_WIDTH) {
                    const oldValue = activeInputs.width;
                    node.inputs.width = 768;
                    warnings.push(`[${node.class_type}] Width invalid: ${oldValue} → setat la 768`);
                    console.warn(`⚠️ Width invalid în nodul ${nodeId}: ${oldValue} → setat la 768`);
                }
            }
            
            // Validează height
            if (activeInputs.height !== undefined) {
                let height = parseInt(activeInputs.height);
                if (isNaN(height) || height < MIN_HEIGHT || height > MAX_HEIGHT) {
                    const oldValue = activeInputs.height;
                    node.inputs.height = 512;
                    warnings.push(`[${node.class_type}] Height invalid: ${oldValue} → setat la 512`);
                    console.warn(`⚠️ Height invalid în nodul ${nodeId}: ${oldValue} → setat la 512`);
                }
            }
        }
        
        // Validează batch_size
        if (activeInputs.batch_size !== undefined) {
            let batchSize = parseInt(activeInputs.batch_size);
            if (isNaN(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
                const oldValue = activeInputs.batch_size;
                node.inputs.batch_size = 1;
                warnings.push(`[${node.class_type}] Batch size invalid: ${oldValue} → setat la 1`);
                console.warn(`⚠️ Batch size invalid în nodul ${nodeId}: ${oldValue} → setat la 1`);
            }
        }
        
        // Validează steps
        if (activeInputs.steps !== undefined) {
            let steps = parseInt(activeInputs.steps);
            if (isNaN(steps) || steps < MIN_STEPS || steps > MAX_STEPS) {
                const oldValue = activeInputs.steps;
                node.inputs.steps = 20;
                warnings.push(`[${node.class_type}] Steps invalid: ${oldValue} → setat la 20`);
                console.warn(`⚠️ Steps invalid în nodul ${nodeId}: ${oldValue} → setat la 20`);
            }
        }
        
        // Validează cfg
        if (activeInputs.cfg !== undefined) {
            let cfg = parseFloat(activeInputs.cfg);
            if (isNaN(cfg) || cfg < MIN_CFG || cfg > MAX_CFG) {
                const oldValue = activeInputs.cfg;
                node.inputs.cfg = 7.0;
                warnings.push(`[${node.class_type}] CFG invalid: ${oldValue} → setat la 7.0`);
                console.warn(`⚠️ CFG invalid în nodul ${nodeId}: ${oldValue} → setat la 7.0`);
            }
        }
        
        // Validează denoise
        if (activeInputs.denoise !== undefined) {
            let denoise = parseFloat(activeInputs.denoise);
            if (isNaN(denoise) || denoise < 0 || denoise > 1) {
                const oldValue = activeInputs.denoise;
                node.inputs.denoise = 1.0;
                warnings.push(`[${node.class_type}] Denoise invalid: ${oldValue} → setat la 1.0`);
                console.warn(`⚠️ Denoise invalid în nodul ${nodeId}: ${oldValue} → setat la 1.0`);
            }
        }
        
        // Validează seed
        if (activeInputs.seed !== undefined) {
            let seed = parseInt(activeInputs.seed);
            if (isNaN(seed) || seed < 0) {
                const oldValue = activeInputs.seed;
                seed = generateRandomSeed();
                node.inputs.seed = seed;
                warnings.push(`[${node.class_type}] Seed invalid: ${oldValue} → generat nou: ${seed}`);
                console.warn(`⚠️ Seed invalid în nodul ${nodeId}: ${oldValue} → generat ${seed}`);
            }
        }
    }
    
    return { workflow, warnings };
}

// ============ ANALIZĂ WORKFLOW - EXTRAȘI TOATE NODURILE ============

function analyzeWorkflow(workflowJson) {
    let workflowApi = null;
    let inputs = [];      // Inputuri media (imagini/video)
    let advancedInputs = []; // Toți parametrii din toate nodurile
    let title = 'Workflow';
    let hasVideoInput = false;
    let hasVideoOutput = false;
    
    // Detectăm formatul ViewComfy
    if (workflowJson.workflows && workflowJson.workflows[0] && workflowJson.workflows[0].workflowApiJSON) {
        console.log('📦 Format detectat: ViewComfy');
        const viewComfy = workflowJson.workflows[0].viewComfyJSON;
        workflowApi = workflowJson.workflows[0].workflowApiJSON;
        title = viewComfy?.title || 'Workflow';
        
        if (viewComfy?.inputs) {
            inputs = viewComfy.inputs;
            hasVideoInput = inputs.some(group => 
                group.inputs?.some(input => input.valueType === 'video')
            );
        }
        
        if (viewComfy?.advancedInputs) {
            advancedInputs = viewComfy.advancedInputs;
        }
        
        // Dacă există viewComfy, prioritizăm acea configurație
        return {
            title: title,
            workflowApi: workflowApi,
            inputs: inputs,
            advancedInputs: advancedInputs,
            hasVideoInput: hasVideoInput,
            hasVideoOutput: hasVideoOutput
        };
    }
    
    // Format standard - analizăm TOATE nodurile și TOȚI parametrii
    if (typeof workflowJson === 'object' && !workflowJson.workflows) {
        console.log('📦 Format detectat: Workflow API Standard');
        workflowApi = workflowJson;
        title = 'Workflow';
        
        // Parcurgem fiecare nod din workflow
        for (const [nodeId, node] of Object.entries(workflowJson)) {
            const nodeTitle = node._meta?.title || node.class_type || nodeId;
            const nodeType = node.class_type || 'Unknown';
            
            // Colectăm toate inputurile nodului
            const nodeInputs = [];
            
            // Pentru nodurile de tip LoadImage / LoadVideo - le tratăm special ca inputuri media
            if (nodeType === 'LoadImage' || nodeType === 'LoadVideo' || nodeType === 'VHS_LoadVideo') {
                const isVideo = (nodeType === 'LoadVideo' || nodeType === 'VHS_LoadVideo');
                if (isVideo) hasVideoInput = true;
                
                // Găsim inputul pentru fișier
                let fileInputName = null;
                if (node.inputs) {
                    for (const [inputName, value] of Object.entries(node.inputs)) {
                        if (inputName.toLowerCase().includes('video') || 
                            inputName.toLowerCase().includes('image') ||
                            inputName === 'video' || inputName === 'image') {
                            fileInputName = inputName;
                            break;
                        }
                    }
                }
                
                inputs.push({
                    key: `media_${nodeId}`,
                    title: nodeTitle,
                    groupTitle: 'Media Input',
                    inputs: [{
                        key: `node_${nodeId}_file`,
                        title: nodeTitle,
                        nodeTitle: nodeTitle, // Duplicate for clarity
                        valueType: isVideo ? 'video' : 'image',
                        nodeId: nodeId,
                        inputName: fileInputName || (isVideo ? 'video' : 'image'),
                        nodeType: nodeType
                    }]
                });
            }
            
            // Pentru toate nodurile, extragem TOȚI parametrii (inclusiv frame_rate, etc.)
            if (node.inputs) {
                for (const [inputName, inputValue] of Object.entries(node.inputs)) {
                    // Sărim peste inputurile care sunt linkuri către alte noduri
                    if (inputValue && typeof inputValue === 'object' && (inputValue[0] || inputValue.hasOwnProperty('0'))) {
                        continue;
                    }
                    
                    // Sărim peste inputurile care sunt fișiere (le tratăm separat)
                    if (inputName === 'image' || inputName === 'video' || 
                        inputName.toLowerCase().includes('file') || inputName === 'filename') {
                        continue;
                    }
                    
                    // Determinăm tipul valorii
                    let valueType = 'text';
                    let defaultValue = inputValue;
                    
                    if (typeof inputValue === 'number') {
                        valueType = 'number';
                        defaultValue = inputValue;
                    } else if (typeof inputValue === 'boolean') {
                        valueType = 'boolean';
                        defaultValue = inputValue;
                    } else if (typeof inputValue === 'string') {
                        valueType = 'text';
                        defaultValue = inputValue;
                    }
                    
                    // Determinăm un titlu frumos pentru parametru
                    let paramTitle = inputName;
                    if (inputName === 'seed') paramTitle = '🔢 Seed';
                    else if (inputName === 'steps') paramTitle = '📊 Steps';
                    else if (inputName === 'cfg') paramTitle = '⚙️ CFG Scale';
                    else if (inputName === 'sampler_name') paramTitle = '🎛️ Sampler';
                    else if (inputName === 'scheduler') paramTitle = '📅 Scheduler';
                    else if (inputName === 'denoise') paramTitle = '🌀 Denoise';
                    else if (inputName === 'text') paramTitle = '📝 Text';
                    else if (inputName === 'prompt') paramTitle = '💬 Prompt';
                    else if (inputName === 'positive') paramTitle = '➕ Positive Prompt';
                    else if (inputName === 'negative') paramTitle = '➖ Negative Prompt';
                    else if (inputName === 'width') paramTitle = '📐 Width';
                    else if (inputName === 'height') paramTitle = '📏 Height';
                    else if (inputName === 'batch_size') paramTitle = '📚 Batch Size';
                    else if (inputName === 'strength') paramTitle = '💪 Strength';
                    else if (inputName === 'noise_seed') paramTitle = '🎲 Noise Seed';
                    else if (inputName === 'length') paramTitle = '🎬 Length (frames)';
                    else if (inputName === 'num_frames') paramTitle = '🎬 Num Frames';
                    else if (inputName === 'frame_rate') paramTitle = '📽️ Frame Rate (FPS)';
                    
                    nodeInputs.push({
                        key: `node_${nodeId}_${inputName}`,
                        title: paramTitle,
                        originalName: inputName,
                        valueType: valueType,
                        nodeId: nodeId,
                        nodeTitle: nodeTitle,
                        nodeType: nodeType,
                        inputName: inputName,
                        defaultValue: defaultValue
                    });
                }
            }
            
            // Dacă nodul are parametri, adăugăm grupul
            if (nodeInputs.length > 0) {
                advancedInputs.push({
                    key: `node_${nodeId}`,
                    title: `📦 ${nodeTitle} (${nodeType})`,
                    nodeId: nodeId,
                    nodeType: nodeType,
                    inputs: nodeInputs
                });
                console.log(`✅ Nod detectat: ${nodeTitle} (${nodeType}) cu ${nodeInputs.length} parametri`);
                for (const input of nodeInputs) {
                    console.log(`   - ${input.originalName}: ${input.defaultValue} (${input.valueType})`);
                }
            }
            
            // Detectăm output video
            if (nodeType === 'SaveVideo' || nodeType === 'VHS_VideoCombine' || nodeType === 'VideoCombine') {
                hasVideoOutput = true;
            }
        }
        
        console.log(`📊 Analiză completă: ${inputs.length} inputuri media, ${advancedInputs.length} grupuri de parametri`);
    }
    
    if (!workflowApi) {
        throw new Error('Workflow-ul nu conține un format valid');
    }
    
    return {
        title: title,
        workflowApi: workflowApi,
        inputs: inputs,
        advancedInputs: advancedInputs,
        hasVideoInput: hasVideoInput,
        hasVideoOutput: hasVideoOutput
    };
}

// ============ CREARE SERVERE ============

// Server Admin (port 3001)
const adminApp = express();
adminApp.use(express.json({ limit: '100mb' }));

// Middleware control cache pentru a asigura actualizarea rapidă a UI
adminApp.use((req, res, next) => {
    // Aggressive cache-busting for all assets and APIs
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    next();
});

adminApp.use(express.static('public', {
    setHeaders: (res, path) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
}));
adminApp.use('/output', express.static('output', {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.mp4')) {
            res.setHeader('Content-Type', 'video/mp4');
        } else if (filePath.endsWith('.webm')) {
            res.setHeader('Content-Type', 'video/webm');
        } else if (filePath.endsWith('.mov')) {
            res.setHeader('Content-Type', 'video/quicktime');
        } else if (filePath.endsWith('.png')) {
            res.setHeader('Content-Type', 'image/png');
        } else if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) {
            res.setHeader('Content-Type', 'image/jpeg');
        }
    }
}));

// Server Public (port 3002)
const publicApp = express();
publicApp.use(express.json({ limit: '100mb' }));

// Middleware control cache public
publicApp.use((req, res, next) => {
    // Aggressive cache-busting for all assets and APIs
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    next();
});

// Serve public.html for root on public port
publicApp.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'public.html'));
});

publicApp.use(express.static('public', {
    setHeaders: (res, path) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
}));
publicApp.use('/output', express.static('output', {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.mp4')) {
            res.setHeader('Content-Type', 'video/mp4');
        } else if (filePath.endsWith('.webm')) {
            res.setHeader('Content-Type', 'video/webm');
        } else if (filePath.endsWith('.mov')) {
            res.setHeader('Content-Type', 'video/quicktime');
        } else if (filePath.endsWith('.png')) {
            res.setHeader('Content-Type', 'image/png');
        } else if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) {
            res.setHeader('Content-Type', 'image/jpeg');
        }
    }
}));

// ============ RUTE ADMIN ============

// Lista workflow-urilor salvate
adminApp.get('/api/workflows/list', (req, res) => {
    try {
        const savedDir = path.join('workflows', 'saved');
        if (!fs.existsSync(savedDir)) {
            fs.mkdirSync(savedDir, { recursive: true });
            return res.json({ success: true, workflows: [] });
        }
        
        const files = fs.readdirSync(savedDir);
        const workflows = files
            .filter(f => f.endsWith('.json'))
            .map(f => {
                try {
                    const filePath = path.join(savedDir, f);
                    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    return {
                        id: f.replace('.json', ''),
                        name: content.metadata?.name || f.replace('.json', ''),
                        description: content.metadata?.description || '',
                        createdAt: content.metadata?.createdAt || fs.statSync(filePath).mtime
                    };
                } catch (e) { 
                    console.error('Error reading file:', f, e.message);
                    return null; 
                }
            })
            .filter(w => w !== null)
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        
        res.json({ success: true, workflows });
    } catch (error) {
        console.error('List workflows error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Helper pentru a reconcilia și completa uiConfig
function reconcileUIConfig(analysis, existingConfig) {
    const config = {
        visibleInputs: (existingConfig && existingConfig.visibleInputs) || {},
        visibleParams: (existingConfig && existingConfig.visibleParams) || {},
        inputOrder: (existingConfig && existingConfig.inputOrder) || [],
        inputNames: (existingConfig && existingConfig.inputNames) || {}
    };

    const allKeys = [];
    if (analysis.inputs) {
        analysis.inputs.forEach(g => g.inputs.forEach(i => {
            allKeys.push(i.key);
            if (config.visibleInputs[i.key] === undefined) config.visibleInputs[i.key] = true;
        }));
    }
    if (analysis.advancedInputs) {
        analysis.advancedInputs.forEach(g => g.inputs.forEach(p => {
            allKeys.push(p.key);
            if (config.visibleParams[p.key] === undefined) config.visibleParams[p.key] = true;
        }));
    }

    // Păstrează ordinea existentă, elimină cheile invalide, adaugă cheile noi la final
    const filteredOrder = config.inputOrder.filter(k => allKeys.includes(k));
    const newKeys = allKeys.filter(k => !filteredOrder.includes(k));
    config.inputOrder = [...filteredOrder, ...newKeys];

    return config;
}

// Încarcă workflow salvat
adminApp.post('/api/workflows/load/:id', (req, res) => {
    try {
        const { id } = req.params;
        const savedDir = path.join('workflows', 'saved');
        const files = fs.readdirSync(savedDir);
        const file = files.find(f => f.includes(id));
        if (!file) return res.status(404).json({ error: 'Workflow negăsit' });
        
        const filePath = path.join(savedDir, file);
        const savedData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        
        currentWorkflowData = {
            raw: savedData.workflow,
            analysis: savedData.analysis,
            workflowApi: savedData.analysis.workflowApi || savedData.workflow
        };
        currentWorkflowId = id;

        // Reconciliare config
        uiConfig = reconcileUIConfig(savedData.analysis, savedData.uiConfig);
        
        // EXTRAGE TOATE VALORILE ORIGINALE DIN WORKFLOW
        originalWorkflowValues = extractOriginalWorkflowValues(currentWorkflowData.workflowApi);
        
        res.json({ 
            success: true, 
            analysis: savedData.analysis, 
            metadata: savedData.metadata,
            uiConfig: uiConfig,
            originalValues: originalWorkflowValues
        });
    } catch (error) {
        console.error('Load workflow error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Salvează workflow curent
adminApp.post('/api/workflows/save', (req, res) => {
    try {
        const { name, description, presets } = req.body;
        if (!currentWorkflowData) return res.status(400).json({ error: 'Nu există workflow încărcat' });
        
        const id = generateId();
        const filename = `${name.replace(/[^a-z0-9]/gi, '_')}_${id}.json`;
        const filePath = path.join('workflows', 'saved', filename);
        
        const savedData = {
            metadata: { 
                id, 
                name, 
                description: description || '', 
                createdAt: new Date().toISOString(),
                presets: presets || [] 
            },
            workflow: currentWorkflowData.raw,
            analysis: currentWorkflowData.analysis,
            uiConfig: uiConfig
        };
        
        fs.writeFileSync(filePath, JSON.stringify(savedData, null, 2));
        currentWorkflowId = id; // Setăm ID-ul curent după salvare
        res.json({ success: true, filename, id, name });
    } catch (error) {
        console.error('Save workflow error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Șterge workflow
adminApp.delete('/api/workflows/delete/:id', (req, res) => {
    try {
        const { id } = req.params;
        const savedDir = path.join('workflows', 'saved');
        
        if (!fs.existsSync(savedDir)) {
            return res.status(404).json({ error: 'Directorul workflows nu există' });
        }
        
        const files = fs.readdirSync(savedDir);
        const file = files.find(f => f.includes(id));
        
        if (!file) {
            return res.status(404).json({ error: 'Workflow negăsit' });
        }
        
        fs.unlinkSync(path.join(savedDir, file));
        res.json({ success: true });
    } catch (error) {
        console.error('Delete workflow error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Încarcă workflow nou
adminApp.post('/api/workflow/upload', upload.single('workflow'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Nu a fost încărcat niciun fișier' });
        
        const workflowContent = fs.readFileSync(req.file.path, 'utf8');
        const workflowJson = JSON.parse(workflowContent);
        const analysis = analyzeWorkflow(workflowJson);
        
        currentWorkflowData = {
            raw: workflowJson,
            analysis: analysis,
            workflowApi: analysis.workflowApi
        };
        
        // EXTRAGE TOATE VALORILE ORIGINALE DIN WORKFLOW
        originalWorkflowValues = extractOriginalWorkflowValues(currentWorkflowData.workflowApi);
        console.log(`📦 Extrase ${Object.keys(originalWorkflowValues).length} valori originale din workflow nou`);
        
        // Inițializează uiConfig cu toți parametrii vizibili
        uiConfig = {
            visibleInputs: {},
            visibleParams: {},
            inputOrder: [],
            inputNames: {}
        };
        
        // Inițializează toți parametrii ca vizibili și adaugă-i în ordinea unică
        if (analysis.inputs) {
            for (const group of analysis.inputs) {
                for (const input of group.inputs) {
                    uiConfig.visibleInputs[input.key] = true;
                    if (!uiConfig.inputOrder.includes(input.key)) {
                        uiConfig.inputOrder.push(input.key);
                    }
                }
            }
        }

        if (analysis.advancedInputs) {
            for (const group of analysis.advancedInputs) {
                for (const param of group.inputs) {
                    uiConfig.visibleParams[param.key] = true;
                    if (!uiConfig.inputOrder.includes(param.key)) {
                        uiConfig.inputOrder.push(param.key);
                    }
                }
            }
        }
        
        fs.unlinkSync(req.file.path);
        res.json({ success: true, analysis, originalValues: originalWorkflowValues, uiConfig: uiConfig });
    } catch (error) {
        console.error('Workflow upload error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Salvează configurația interfeței
adminApp.post('/api/config/save', (req, res) => {
    try {
        const { config } = req.body;
        uiConfig = config;

        // Dacă avem un workflow încărcat, salvăm configurația direct în fișierul lui
        if (currentWorkflowId) {
            const savedDir = path.join('workflows', 'saved');
            const files = fs.readdirSync(savedDir);
            const file = files.find(f => f.includes(currentWorkflowId));

            if (file) {
                const filePath = path.join(savedDir, file);
                const savedData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                savedData.uiConfig = config;
                fs.writeFileSync(filePath, JSON.stringify(savedData, null, 2));
                console.log(`💾 UI Config salvat pentru workflow: ${currentWorkflowId}`);
            }
        }

        // De asemenea, salvăm în locația globală pentru compatibilitate
        fs.writeFileSync(path.join('workflows', 'ui_config.json'), JSON.stringify(config, null, 2));
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Încarcă configurația
adminApp.get('/api/config/load', (req, res) => {
    try {
        const configPath = path.join('workflows', 'ui_config.json');
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            uiConfig = config;
            res.json({ success: true, config });
        } else {
            res.json({ success: true, config: { visibleInputs: {}, visibleParams: {}, inputOrder: [], inputNames: {} } });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Media store to keep track of uploaded files local paths
const mediaStore = {};

// Upload media
adminApp.post('/api/upload/media/:inputKey', upload.single('media'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Nu a fost încărcat niciun fișier' });
        
        const inputKey = req.params.inputKey;
        const isVideo = req.file.mimetype.startsWith('video/');
        
        // Save to output directory so it can be previewed by the frontend
        const localFilename = `${generateId()}${path.extname(req.file.originalname)}`;
        const localPath = path.join('output', localFilename);
        fs.renameSync(req.file.path, localPath);
        
        mediaStore[localFilename] = {
            path: localPath,
            originalName: req.file.originalname,
            mimetype: req.file.mimetype
        };
        
        res.json({ 
            success: true, 
            filename: localFilename,
            inputKey: inputKey,
            type: isVideo ? 'video' : 'image'
        });
    } catch (error) {
        console.error('Media upload error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Rulează workflow
adminApp.post('/api/workflow/run', async (req, res) => {
    try {
        const { mediaFiles, parameters, bypassedNodes } = req.body;
        if (!currentWorkflowData || !currentWorkflowData.workflowApi) {
            return res.status(400).json({ error: 'Nu există workflow încărcat' });
        }

        // Selectăm instanța cea mai liberă
        const targetInstance = await getFreestInstance();
        console.log(`🎯 Executing on instance: ${targetInstance}`);
        
        let workflow = JSON.parse(JSON.stringify(currentWorkflowData.workflowApi));

        // Aplicăm bypass-ul pentru noduri (graph surgery)
        workflow = applyBypass(workflow, bypassedNodes);
        
        // Înlocuim fișierele media și le uploadăm la instanța țintă dacă e necesar
        for (const [inputKey, filename] of Object.entries(mediaFiles || {})) {
            let finalFilename = filename;
            if (mediaStore[filename]) {
                const uploadResult = await uploadFileToInstance(targetInstance, mediaStore[filename].path, mediaStore[filename].originalName, mediaStore[filename].mimetype);
                finalFilename = uploadResult.name;
            }

            for (const inputGroup of currentWorkflowData.analysis.inputs) {
                for (const input of inputGroup.inputs || []) {
                    if (input.key === inputKey && input.nodeId && workflow[input.nodeId]) {
                        if (bypassedNodes && bypassedNodes[input.nodeId]) continue;
                        workflow[input.nodeId].inputs[input.inputName] = finalFilename;
                    }
                }
            }
        }
        
        // IMPORTANT: PĂSTRĂM VALORILE ORIGINALE PENTRU PARAMETRII ASCUNȘI
        const finalParameters = { ...originalWorkflowValues };
        
        // Actualizăm doar parametrii care au fost modificați explicit de utilizator (cei vizibili)
        for (const [paramKey, value] of Object.entries(parameters || {})) {
            if (paramKey !== '_autoRandomSeed') {
                finalParameters[paramKey] = value;
            }
        }
        
        const autoRandomFlags = parameters['_autoRandomSeed'] || {};
        
        for (const [paramKey, value] of Object.entries(finalParameters)) {
            if (shouldGenerateRandomSeed(paramKey, value, autoRandomFlags)) {
                finalParameters[paramKey] = generateRandomSeed();
                console.log(`Generated random seed for ${paramKey}: ${finalParameters[paramKey]}`);
            }
        }
        
        for (const [paramKey, value] of Object.entries(finalParameters)) {
            for (const paramGroup of currentWorkflowData.analysis.advancedInputs) {
                for (const param of paramGroup.inputs || []) {
                    if (param.key === paramKey && param.nodeId && workflow[param.nodeId]) {
                        if (bypassedNodes && bypassedNodes[param.nodeId]) continue;
                        let finalValue = value;
                        if (param.valueType === 'number' || param.valueType === 'float') {
                            finalValue = parseFloat(value);
                            if (isNaN(finalValue)) finalValue = 0;
                        }
                        else if (param.valueType === 'boolean') finalValue = value === 'true' || value === true;
                        workflow[param.nodeId].inputs[param.inputName] = finalValue;
                        console.log(`✅ Aplicat ${param.key} = ${finalValue} la nodul ${param.nodeId}.${param.inputName}`);
                    }
                }
            }
        }
        
        // VALIDARE PARAMETRI
        const { workflow: validatedWorkflow, warnings } = validateWorkflowParameters(workflow, finalParameters);
        
        // Trimitem workflow-ul la instanța selectată
        const queueRes = await fetch(`${targetInstance}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: validatedWorkflow })
        });
        
        const responseText = await queueRes.text();
        let queueData;
        try {
            queueData = JSON.parse(responseText);
        } catch (e) {
            throw new Error(`ComfyUI error: ${responseText.substring(0, 200)}`);
        }
        
        if (queueData.error) {
            throw new Error(queueData.error.message || JSON.stringify(queueData.error));
        }
        
        const promptId = queueData.prompt_id;
        let result = null;
        let attempts = 0;
        
        while (!result && attempts < 380) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            const historyRes = await fetch(`${targetInstance}/history`);
            const history = await historyRes.json();
            if (history[promptId]) {
                result = history[promptId];
                break;
            }
            attempts++;
        }
        
        if (!result) throw new Error('Timeout așteptând rezultatul');
        
        if (result.status && result.status.messages) {
            const errors = result.status.messages.filter(m => m[0] === 'execution_error');
            if (errors.length > 0) {
                const errorDetail = errors[0][1];
                throw new Error(`ComfyUI Execution Error: ${errorDetail.exception_type} - ${errorDetail.exception_message}`);
            }
        }

        const outputFiles = [];
        for (const [nodeId, output] of Object.entries(result.outputs || {})) {
            if (output.images && Array.isArray(output.images)) {
                for (const img of output.images) {
                    const fileUrl = `${targetInstance}/view?filename=${encodeURIComponent(img.filename)}&type=${img.type}&subfolder=${img.subfolder || ''}`;
                    const fileRes = await fetch(fileUrl);
                    const fileBuffer = await fileRes.buffer();
                    const ext = path.extname(img.filename) || '.png';
                    const localFilename = `${generateId()}${ext}`;
                    fs.writeFileSync(path.join('output', localFilename), fileBuffer);
                    outputFiles.push({ 
                        filename: localFilename, 
                        url: `/output/${localFilename}`, 
                        type: img.type === 'video' || ext === '.mp4' ? 'video' : 'image' 
                    });
                }
            }
            if (output.videos && Array.isArray(output.videos)) {
                for (const video of output.videos) {
                    const fileUrl = `${targetInstance}/view?filename=${encodeURIComponent(video.filename)}&type=${video.type}&subfolder=${video.subfolder || ''}`;
                    const fileRes = await fetch(fileUrl);
                    const fileBuffer = await fileRes.buffer();
                    const ext = path.extname(video.filename) || '.mp4';
                    const localFilename = `${generateId()}${ext}`;
                    fs.writeFileSync(path.join('output', localFilename), fileBuffer);
                    outputFiles.push({ 
                        filename: localFilename, 
                        url: `/output/${localFilename}`, 
                        type: 'video' 
                    });
                }
            }
        }
        
        res.json({ success: true, files: outputFiles, warnings: warnings.length > 0 ? warnings : undefined });
    } catch (error) {
        console.error('Workflow run error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Port config endpoint
adminApp.get('/api/config', (req, res) => {
    res.json({
        adminPort: ADMIN_PORT,
        publicPort: PUBLIC_PORT,
        comfyuiUrls: COMFYUI_URLS
    });
});

// API pentru setări server
adminApp.post('/api/settings', (req, res) => {
    try {
        const { comfyuiUrls } = req.body;
        if (comfyuiUrls && Array.isArray(comfyuiUrls) && comfyuiUrls.length > 0) {
            COMFYUI_URLS = comfyuiUrls;
            CONFIG.COMFYUI_URLS = COMFYUI_URLS;
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(CONFIG, null, 2));
            console.log(`🔧 URL-uri ComfyUI actualizate: ${COMFYUI_URLS.join(', ')}`);
            res.json({ success: true, comfyuiUrls: COMFYUI_URLS });
        } else {
            res.status(400).json({ error: 'URL-uri invalide' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API pentru ștergere fișier din output
adminApp.delete('/api/outputs/:filename', (req, res) => {
    try {
        const { filename } = req.params;
        const filePath = path.join('output', filename);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Fișier negăsit' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API pentru browser de fișiere (Output)
adminApp.get('/api/outputs', (req, res) => {
    try {
        const outputDir = 'output';
        if (!fs.existsSync(outputDir)) return res.json({ files: [] });

        const files = fs.readdirSync(outputDir)
            .filter(f => ['.png', '.jpg', '.jpeg', '.mp4', '.webm', '.gif'].includes(path.extname(f).toLowerCase()))
            .map(f => {
                const stat = fs.statSync(path.join(outputDir, f));
                return {
                    name: f,
                    url: `/output/${f}`,
                    type: ['.mp4', '.webm'].includes(path.extname(f).toLowerCase()) ? 'video' : 'image',
                    mtime: stat.mtime
                };
            })
            .sort((a, b) => b.mtime - a.mtime);

        res.json({ files });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Health check admin
adminApp.get('/api/health', async (req, res) => {
    try {
        const results = await Promise.all(COMFYUI_URLS.map(async (url) => {
            try {
                const response = await fetch(`${url}/system_stats`, { timeout: 2000 });
                return { url, status: response.ok ? 'connected' : 'disconnected' };
            } catch (e) {
                return { url, status: 'disconnected' };
            }
        }));

        const connectedCount = results.filter(r => r.status === 'connected').length;
        res.json({
            status: connectedCount > 0 ? 'ok' : 'error',
            comfyui: connectedCount > 0 ? 'connected' : 'disconnected',
            instances: results
        });
    } catch (error) {
        res.json({ status: 'error', comfyui: 'disconnected' });
    }
});

// ============ RUTE PUBLIC ============

// Lista workflow-uri pentru public
publicApp.get('/api/workflows/list', (req, res) => {
    try {
        const savedDir = path.join('workflows', 'saved');
        if (!fs.existsSync(savedDir)) {
            fs.mkdirSync(savedDir, { recursive: true });
            return res.json({ success: true, workflows: [] });
        }
        
        const files = fs.readdirSync(savedDir);
        const workflows = files
            .filter(f => f.endsWith('.json'))
            .map(f => {
                try {
                    const filePath = path.join(savedDir, f);
                    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    return {
                        id: f.replace('.json', ''),
                        name: content.metadata?.name || f.replace('.json', ''),
                        description: content.metadata?.description || ''
                    };
                } catch (e) { return null; }
            })
            .filter(w => w !== null);
        
        res.json({ success: true, workflows });
    } catch (error) {
        console.error('Public list workflows error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Încarcă workflow pentru public
publicApp.post('/api/workflows/load/:id', (req, res) => {
    try {
        const { id } = req.params;
        const savedDir = path.join('workflows', 'saved');
        const files = fs.readdirSync(savedDir);
        const file = files.find(f => f.includes(id));
        if (!file) return res.status(404).json({ error: 'Workflow negăsit' });
        
        const filePath = path.join(savedDir, file);
        const savedData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        
        const publicAnalysis = {
            title: savedData.analysis.title,
            inputs: savedData.analysis.inputs,
            advancedInputs: savedData.analysis.advancedInputs,
            hasVideoInput: savedData.analysis.hasVideoInput,
            hasVideoOutput: savedData.analysis.hasVideoOutput
        };
        
        // Reconciliare config pentru public (folosim funcția comună)
        const publicUIConfig = reconcileUIConfig(savedData.analysis, savedData.uiConfig);
        
        const originalValues = extractOriginalWorkflowValues(savedData.analysis.workflowApi);
        
        res.json({ 
            success: true, 
            analysis: publicAnalysis, 
            presets: savedData.metadata?.presets || [],
            uiConfig: publicUIConfig,
            originalValues: originalValues
        });
    } catch (error) {
        console.error('Public load workflow error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Upload media pentru public
publicApp.post('/api/upload/media/:inputKey', upload.single('media'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Nu a fost încărcat niciun fișier' });
        
        const inputKey = req.params.inputKey;
        const isVideo = req.file.mimetype.startsWith('video/');
        
        // Save to output directory
        const localFilename = `${generateId()}${path.extname(req.file.originalname)}`;
        const localPath = path.join('output', localFilename);
        fs.renameSync(req.file.path, localPath);
        
        mediaStore[localFilename] = {
            path: localPath,
            originalName: req.file.originalname,
            mimetype: req.file.mimetype
        };
        
        res.json({ 
            success: true, 
            filename: localFilename,
            inputKey: inputKey,
            type: isVideo ? 'video' : 'image'
        });
    } catch (error) {
        console.error('Public media upload error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Rulează workflow pentru public
publicApp.post('/api/workflow/run', async (req, res) => {
    try {
        const { mediaFiles, parameters, workflowId, bypassedNodes } = req.body;
        
        const savedDir = path.join('workflows', 'saved');
        const files = fs.readdirSync(savedDir);
        const file = files.find(f => f.includes(workflowId));
        if (!file) return res.status(404).json({ error: 'Workflow negăsit' });

        // Selectăm instanța cea mai liberă
        const targetInstance = await getFreestInstance();
        console.log(`🎯 [Public] Executing on instance: ${targetInstance}`);
        
        const filePath = path.join(savedDir, file);
        const savedData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        let workflow = JSON.parse(JSON.stringify(savedData.analysis.workflowApi || savedData.workflow));

        // Aplicăm bypass-ul pentru noduri (graph surgery)
        workflow = applyBypass(workflow, bypassedNodes);
        const analysis = savedData.analysis;
        
        // Extrage valorile originale
        const originalValues = extractOriginalWorkflowValues(workflow);
        
        for (const [inputKey, filename] of Object.entries(mediaFiles || {})) {
            let finalFilename = filename;
            if (mediaStore[filename]) {
                const uploadResult = await uploadFileToInstance(targetInstance, mediaStore[filename].path, mediaStore[filename].originalName, mediaStore[filename].mimetype);
                finalFilename = uploadResult.name;
            }

            for (const inputGroup of analysis.inputs) {
                for (const input of inputGroup.inputs || []) {
                    if (input.key === inputKey && input.nodeId && workflow[input.nodeId]) {
                        if (bypassedNodes && bypassedNodes[input.nodeId]) continue;
                        workflow[input.nodeId].inputs[input.inputName] = finalFilename;
                    }
                }
            }
        }
        
        // PĂSTRĂM VALORILE ORIGINALE PENTRU PARAMETRII ASCUNȘI
        const finalParameters = { ...originalValues };
        
        // Actualizăm doar parametrii vizibili modificați
        for (const [paramKey, value] of Object.entries(parameters || {})) {
            if (paramKey !== '_autoRandomSeed') {
                finalParameters[paramKey] = value;
            }
        }
        
        const autoRandomFlags = parameters['_autoRandomSeed'] || {};
        
        for (const [paramKey, value] of Object.entries(finalParameters)) {
            if (shouldGenerateRandomSeed(paramKey, value, autoRandomFlags)) {
                finalParameters[paramKey] = generateRandomSeed();
                console.log(`Generated random seed for ${paramKey}: ${finalParameters[paramKey]}`);
            }
        }
        
        for (const [paramKey, value] of Object.entries(finalParameters)) {
            for (const paramGroup of analysis.advancedInputs) {
                for (const param of paramGroup.inputs || []) {
                    if (param.key === paramKey && param.nodeId && workflow[param.nodeId]) {
                        if (bypassedNodes && bypassedNodes[param.nodeId]) continue;
                        let finalValue = value;
                        if (param.valueType === 'number' || param.valueType === 'float') {
                            finalValue = parseFloat(value);
                            if (isNaN(finalValue)) finalValue = 0;
                        }
                        else if (param.valueType === 'boolean') finalValue = value === 'true' || value === true;
                        workflow[param.nodeId].inputs[param.inputName] = finalValue;
                    }
                }
            }
        }
        
        // VALIDARE PARAMETRI
        const { workflow: validatedWorkflow, warnings } = validateWorkflowParameters(workflow, finalParameters);
        
        const queueRes = await fetch(`${targetInstance}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: validatedWorkflow })
        });
        
        const responseText = await queueRes.text();
        let queueData;
        try {
            queueData = JSON.parse(responseText);
        } catch (e) {
            throw new Error(`ComfyUI error: ${responseText.substring(0, 200)}`);
        }
        
        if (queueData.error) throw new Error(queueData.error.message || JSON.stringify(queueData.error));
        
        const promptId = queueData.prompt_id;
        let result = null;
        let attempts = 0;
        
        while (!result && attempts < 180) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const historyRes = await fetch(`${targetInstance}/history`);
            const history = await historyRes.json();
            if (history[promptId]) {
                result = history[promptId];
                break;
            }
            attempts++;
        }
        
        if (!result) throw new Error('Timeout așteptând rezultatul');
        
        if (result.status && result.status.messages) {
            const errors = result.status.messages.filter(m => m[0] === 'execution_error');
            if (errors.length > 0) {
                const errorDetail = errors[0][1];
                throw new Error(`ComfyUI Execution Error: ${errorDetail.exception_type} - ${errorDetail.exception_message}`);
            }
        }

        const outputFiles = [];
        for (const [nodeId, output] of Object.entries(result.outputs || {})) {
            if (output.images && Array.isArray(output.images)) {
                for (const img of output.images) {
                    const fileUrl = `${targetInstance}/view?filename=${encodeURIComponent(img.filename)}&type=${img.type}&subfolder=${img.subfolder || ''}`;
                    const fileRes = await fetch(fileUrl);
                    const fileBuffer = await fileRes.buffer();
                    const ext = path.extname(img.filename) || '.png';
                    const localFilename = `${generateId()}${ext}`;
                    fs.writeFileSync(path.join('output', localFilename), fileBuffer);
                    outputFiles.push({ 
                        filename: localFilename, 
                        url: `/output/${localFilename}`, 
                        type: img.type === 'video' || ext === '.mp4' ? 'video' : 'image' 
                    });
                }
            }
            if (output.videos && Array.isArray(output.videos)) {
                for (const video of output.videos) {
                    const fileUrl = `${targetInstance}/view?filename=${encodeURIComponent(video.filename)}&type=${video.type}&subfolder=${video.subfolder || ''}`;
                    const fileRes = await fetch(fileUrl);
                    const fileBuffer = await fileRes.buffer();
                    const ext = path.extname(video.filename) || '.mp4';
                    const localFilename = `${generateId()}${ext}`;
                    fs.writeFileSync(path.join('output', localFilename), fileBuffer);
                    outputFiles.push({ 
                        filename: localFilename, 
                        url: `/output/${localFilename}`, 
                        type: 'video' 
                    });
                }
            }
        }
        
        res.json({ success: true, files: outputFiles, warnings: warnings.length > 0 ? warnings : undefined });
    } catch (error) {
        console.error('Public workflow run error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Port config endpoint
publicApp.get('/api/config', (req, res) => {
    res.json({
        adminPort: ADMIN_PORT,
        publicPort: PUBLIC_PORT,
        comfyuiUrls: COMFYUI_URLS
    });
});

// API pentru browser de fișiere (Public are acces doar la vizualizare)
publicApp.get('/api/outputs', (req, res) => {
    try {
        const outputDir = 'output';
        if (!fs.existsSync(outputDir)) return res.json({ files: [] });

        const files = fs.readdirSync(outputDir)
            .filter(f => ['.png', '.jpg', '.jpeg', '.mp4', '.webm', '.gif'].includes(path.extname(f).toLowerCase()))
            .map(f => {
                const stat = fs.statSync(path.join(outputDir, f));
                return {
                    name: f,
                    url: `/output/${f}`,
                    type: ['.mp4', '.webm'].includes(path.extname(f).toLowerCase()) ? 'video' : 'image',
                    mtime: stat.mtime
                };
            })
            .sort((a, b) => b.mtime - a.mtime);

        res.json({ files });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Health check public
publicApp.get('/api/health', async (req, res) => {
    try {
        const results = await Promise.all(COMFYUI_URLS.map(async (url) => {
            try {
                const response = await fetch(`${url}/system_stats`, { timeout: 2000 });
                return { url, status: response.ok ? 'connected' : 'disconnected' };
            } catch (e) {
                return { url, status: 'disconnected' };
            }
        }));

        const connectedCount = results.filter(r => r.status === 'connected').length;
        res.json({
            status: connectedCount > 0 ? 'ok' : 'error',
            comfyui: connectedCount > 0 ? 'connected' : 'disconnected',
            instances: results
        });
    } catch (error) {
        res.json({ status: 'error', comfyui: 'disconnected' });
    }
});

// ============ PORNIRE SERVER ============

async function startServers() {
    ADMIN_PORT = await findFreePort(ADMIN_PORT);
    // Asigurăm că PUBLIC_PORT nu este același cu ADMIN_PORT
    if (PUBLIC_PORT <= ADMIN_PORT) PUBLIC_PORT = ADMIN_PORT + 1;
    PUBLIC_PORT = await findFreePort(PUBLIC_PORT);

    adminApp.listen(ADMIN_PORT, '0.0.0.0', () => {
        console.log(`
        🔧 ADMIN INTERFACE
        📡 http://localhost:${ADMIN_PORT}
        `);
    });

    publicApp.listen(PUBLIC_PORT, '0.0.0.0', () => {
        console.log(`
        🌐 PUBLIC INTERFACE
        📡 http://localhost:${PUBLIC_PORT}
        `);
    });

    console.log(`
    🚀 ComfyUI Remote Interface
    🔗 ComfyUI Nodes: ${COMFYUI_URLS.join(', ')}
    📁 Workflows: workflows/saved/
    `);
}

startServers();

