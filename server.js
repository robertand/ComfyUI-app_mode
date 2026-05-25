const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const FormData = require('form-data');
const net = require('net');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');

ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

// ============ CONFIGURATION ============
const CONFIG_FILE = path.join('workflows', 'config.json');
let CONFIG = {
    ADMIN_PORT: parseInt(process.env.ADMIN_PORT) || 3001,
    PUBLIC_PORT: parseInt(process.env.PUBLIC_PORT) || 3002,
    COMFYUI_URLS: process.env.COMFYUI_URLS ? process.env.COMFYUI_URLS.split(',') : [process.env.COMFYUI_URL || 'http://127.0.0.1:8188']
};

if (fs.existsSync(CONFIG_FILE)) {
    try {
        const savedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        if (savedConfig.COMFYUI_URL) {
            if (!savedConfig.COMFYUI_URLS || !Array.isArray(savedConfig.COMFYUI_URLS) || savedConfig.COMFYUI_URLS.length === 0) {
                savedConfig.COMFYUI_URLS = [savedConfig.COMFYUI_URL];
            } else if (!savedConfig.COMFYUI_URLS.includes(savedConfig.COMFYUI_URL)) {
                savedConfig.COMFYUI_URLS.unshift(savedConfig.COMFYUI_URL);
            }
        }
        if (savedConfig.COMFYUI_URLS && typeof savedConfig.COMFYUI_URLS === 'string') {
            savedConfig.COMFYUI_URLS = savedConfig.COMFYUI_URLS.split(',').map(s => s.trim());
        }
        CONFIG = { ...CONFIG, ...savedConfig };
    } catch (e) {
        console.error('Error loading config.json:', e.message);
    }
}

if (CONFIG.COMFYUI_URL) delete CONFIG.COMFYUI_URL;

let ADMIN_PORT = CONFIG.ADMIN_PORT;
let PUBLIC_PORT = CONFIG.PUBLIC_PORT;
let COMFYUI_URLS = CONFIG.COMFYUI_URLS;

if (!Array.isArray(COMFYUI_URLS) || COMFYUI_URLS.length === 0) {
    COMFYUI_URLS = ['http://127.0.0.1:8188'];
}

// ============ UTILS ============

async function findFreePort(startPort) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.on('error', () => resolve(findFreePort(startPort + 1)));
        server.listen(startPort, '0.0.0.0', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

const upload = multer({ dest: 'uploads/', limits: { fileSize: 10 * 1024 * 1024 * 1024 } }); // 10GB Limit

['uploads', 'output', 'workflows', 'workflows/saved', 'temp_segments', 'uploads/chunks', 'uploads/media'].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

let currentWorkflowData = null;
let currentWorkflowId = null;
let uiConfig = null;
let originalWorkflowValues = {};
const mediaStore = {};
const cancelledRuns = new Set();

async function getFreestInstance() {
    const instances = COMFYUI_URLS;
    if (instances.length === 1) return instances[0];
    const stats = await Promise.all(instances.map(async (url) => {
        try {
            const res = await fetch(`${url}/queue`, { timeout: 2000 });
            if (!res.ok) return { url, load: Infinity };
            const data = await res.json();
            const load = (data.queue_running?.length || 0) + (data.queue_pending?.length || 0);
            return { url, load };
        } catch (e) { return { url, load: Infinity }; }
    }));
    const sorted = stats.sort((a, b) => a.load - b.load);
    if (sorted[0].load === Infinity) throw new Error('No ComfyUI instance available');
    return sorted[0].url;
}

async function uploadFileToInstance(instanceUrl, filePath, originalName, mimetype) {
    const formData = new FormData();
    formData.append('image', fs.createReadStream(filePath), { filename: originalName, contentType: mimetype });
    const res = await fetch(`${instanceUrl}/upload/image`, { method: 'POST', body: formData, headers: formData.getHeaders() });
    if (!res.ok) throw new Error(`Upload failed to ${instanceUrl}: ${res.status}`);
    return await res.json();
}

const generateId = () => Date.now().toString() + '-' + Math.random().toString(36).substr(2, 9);
const generateRandomSeed = () => Math.floor(Math.random() * 1000000000000);

function shouldGenerateRandomSeed(paramKey, paramValue, autoRandomFlags) {
    if (autoRandomFlags?.[paramKey] === true || autoRandomFlags?.['_global'] === true) return true;
    return paramValue === 'random' || paramValue === '' || paramValue === null;
}

function extractOriginalWorkflowValues(workflowApi) {
    const values = {};
    if (!workflowApi) return values;
    for (const [nodeId, node] of Object.entries(workflowApi)) {
        if (node.inputs) {
            for (const [inputName, inputValue] of Object.entries(node.inputs)) {
                if (inputValue && typeof inputValue === 'object' && (inputValue[0] || inputValue.hasOwnProperty('0'))) continue;
                values[`node_${nodeId}_${inputName}`] = inputValue;
            }
        }
    }
    return values;
}

function applyBypass(workflow, bypassedNodes) {
    if (!bypassedNodes) return workflow;
    Object.entries(bypassedNodes).forEach(([nodeId, isBypassed]) => {
        if (!isBypassed || !workflow[nodeId]) return;
        const node = workflow[nodeId];
        if (node.class_type?.includes('Save') || node.class_type?.includes('Preview') || node.class_type?.includes('Combine')) {
            delete workflow[nodeId]; return;
        }
        let sourceLink = node.inputs ? Object.values(node.inputs).find(v => Array.isArray(v)) : null;
        Object.values(workflow).forEach(other => {
            if (!other.inputs) return;
            Object.entries(other.inputs).forEach(([k, v]) => {
                if (Array.isArray(v) && String(v[0]) === String(nodeId)) {
                    if (sourceLink) other.inputs[k] = sourceLink; else delete other.inputs[k];
                }
            });
        });
        delete workflow[nodeId];
    });
    return workflow;
}

function validateWorkflowParameters(workflow) {
    const warnings = [];
    Object.entries(workflow).forEach(([nodeId, node]) => {
        if (!node.inputs) return;
        const isVideoNode = node.class_type && (node.class_type.includes('LTX') || node.class_type.includes('Video') || node.class_type.includes('VHS_VideoCombine') || node.class_type === 'SaveVideo' || node.class_type.includes('Sampler'));
        
        const check = (key, def, min, max, isInt = false) => {
            if (node.inputs[key] === undefined || Array.isArray(node.inputs[key])) return;
            let val = isInt ? parseInt(node.inputs[key]) : parseFloat(node.inputs[key]);
            if (isNaN(val) || (min !== undefined && val < min) || (max !== undefined && val > max)) {
                node.inputs[key] = def;
                warnings.push(`[${node.class_type}] ${key} invalid: ${val} -> ${def}`);
            }
        };

        if (isVideoNode) {
            check('length', 25, 1, 300); check('num_frames', 25, 1, 300);
            check('frame_rate', 24, 0.1, 120); check('width', 768, 64, 2048, true); check('height', 512, 64, 2048, true);
        }
        check('batch_size', 1, 1, 16, true); check('steps', 20, 1, 100, true);
        check('cfg', 7.0, 0, 100); check('denoise', 1.0, 0, 1.0);
        if (node.inputs.seed !== undefined && !Array.isArray(node.inputs.seed)) {
            if (isNaN(parseInt(node.inputs.seed)) || node.inputs.seed < 0) node.inputs.seed = generateRandomSeed();
        }
    });
    return { workflow, warnings };
}

function analyzeWorkflow(workflowJson) {
    let workflowApi = null, inputs = [], advancedInputs = [], title = 'Workflow', hasVideoInput = false, hasVideoOutput = false;
    
    if (workflowJson.workflows?.[0]?.workflowApiJSON) {
        const viewComfy = workflowJson.workflows[0].viewComfyJSON;
        workflowApi = workflowJson.workflows[0].workflowApiJSON;
        title = viewComfy?.title || 'Workflow';
        if (viewComfy?.inputs) {
            inputs = viewComfy.inputs;
            hasVideoInput = inputs.some(g => g.inputs?.some(i => i.valueType === 'video'));
        }
        if (viewComfy?.advancedInputs) advancedInputs = viewComfy.advancedInputs;
        return { title, workflowApi, inputs, advancedInputs, hasVideoInput, hasVideoOutput };
    }
    
    if (typeof workflowJson === 'object' && !workflowJson.workflows) {
        workflowApi = workflowJson;
        Object.entries(workflowJson).forEach(([nodeId, node]) => {
            const nodeTitle = node._meta?.title || node.class_type || nodeId;
            const nodeType = node.class_type || 'Unknown';
            const nodeInputs = [];
            
            if (['LoadImage', 'LoadVideo', 'VHS_LoadVideo'].includes(nodeType)) {
                const isVideo = nodeType.includes('Video');
                if (isVideo) hasVideoInput = true;
                let fileInputName = node.inputs ? Object.keys(node.inputs).find(k => k.toLowerCase().includes('video') || k.toLowerCase().includes('image')) : (isVideo ? 'video' : 'image');
                inputs.push({ key: `media_${nodeId}`, title: nodeTitle, groupTitle: 'Media Input', inputs: [{ key: `node_${nodeId}_file`, title: nodeTitle, nodeTitle, valueType: isVideo ? 'video' : 'image', nodeId, inputName: fileInputName, nodeType }] });
            }
            
            if (node.inputs) {
                Object.entries(node.inputs).forEach(([inputName, inputValue]) => {
                    const isPixaromaWidget = (nodeType === 'Pixaroma3D' && inputName === 'SceneWidget') || (nodeType === 'PixaromaPaint' && inputName === 'PaintWidget') || (nodeType === 'PixaromaImageComposition' && inputName === 'ComposerWidget') || (nodeType === 'PixaromaCrop' && inputName === 'CropWidget');
                    if (inputValue && typeof inputValue === 'object' && (inputValue[0] || inputValue.hasOwnProperty('0'))) return;
                    if (!isPixaromaWidget && (inputName === 'image' || inputName === 'video' || inputName.toLowerCase().includes('file') || inputName === 'filename')) return;
                    if (nodeType.startsWith('Pixaroma') && inputName.startsWith('Open')) return;
                    
                    let valueType = 'text';
                    if (isPixaromaWidget) valueType = 'pixaroma_editor';
                    else if (typeof inputValue === 'number') valueType = 'number';
                    else if (typeof inputValue === 'boolean') valueType = 'boolean';
                    
                    const pTitles = { seed: '🔢 Seed', steps: '📊 Steps', cfg: '⚙️ CFG Scale', SceneWidget: '3D Builder', PaintWidget: 'Paint Studio', ComposerWidget: 'Image Composer', CropWidget: 'Image Crop' };
                    nodeInputs.push({ key: `node_${nodeId}_${inputName}`, title: pTitles[inputName] || inputName, originalName: inputName, valueType, nodeId, nodeTitle, nodeType, inputName, defaultValue: isPixaromaWidget ? (typeof inputValue === 'object' ? JSON.stringify(inputValue) : inputValue) : inputValue });
                });
            }
            if (nodeInputs.length > 0) advancedInputs.push({ key: `node_${nodeId}`, title: `📦 ${nodeTitle}`, nodeId, nodeType, inputs: nodeInputs });
            if (['SaveVideo', 'VHS_VideoCombine', 'VideoCombine'].includes(nodeType)) hasVideoOutput = true;
        });
    }
    if (!workflowApi) throw new Error('Workflow format invalid');
    return { title, workflowApi, inputs, advancedInputs, hasVideoInput, hasVideoOutput };
}

// ============ APPS & PROXY ============

const adminApp = express();
const publicApp = express();
const apps = [adminApp, publicApp];

apps.forEach(app => {
    app.use((req, res, next) => {
        if (req.path.includes('/api/upload/media/') || req.path.includes('/api/upload/chunk')) {
            next(); // Let multer handle it
        } else {
            express.json({ limit: '500mb' })(req, res, next);
        }
    });
    app.use((req, res, next) => {
        if (req.path.includes('/api/upload/media/') || req.path.includes('/api/upload/chunk')) {
            next();
        } else {
            express.urlencoded({ limit: '500mb', extended: true })(req, res, next);
        }
    });
    app.use((req, res, next) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        next();
    });
});

async function proxyToComfy(req, res) {
    try {
        const targetInstance = await getFreestInstance();
        const targetPath = req.originalUrl;
        const fetchOptions = { method: req.method, headers: { ...req.headers }, redirect: 'manual' };
        const parsedTarget = new URL(targetInstance);
        delete fetchOptions.headers.host;
        fetchOptions.headers['origin'] = parsedTarget.origin;
        fetchOptions.headers['referer'] = parsedTarget.origin + '/';

        if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
            fetchOptions.body = (req.headers['content-type']?.includes('application/json') && req.body && Object.keys(req.body).length > 0) ? JSON.stringify(req.body) : req;
        }

        let response = await fetch(`${targetInstance}${targetPath}`, fetchOptions);

        if (response.status === 404 && (targetPath.includes('pixaroma') || targetPath.includes('Pixaroma'))) {
            const variants = ['ComfyUI-Pixaroma', 'ComfyUI_Pixaroma', 'pixaroma', 'Pixaroma', 'comfyui-pixaroma'];
            const fallbacks = [];
            for (const v of variants) {
                const ext = `/extensions/${v}/`;
                if (targetPath.includes('/assets/')) {
                    const sub = targetPath.split('/assets/')[1];
                    fallbacks.push(ext + sub, ext + 'js/' + sub, ext + 'assets/' + sub);
                }
                fallbacks.push(targetPath.replace('/pixaroma/assets/', ext), targetPath.replace('/pixaroma/assets/', ext + 'js/'), targetPath.replace('/pixaroma/js/', ext), targetPath.replace('/pixaroma/', ext), targetPath.replace('/pixaroma/', ext + 'js/'));
                if (targetPath.endsWith('.js') || targetPath.endsWith('.mjs')) {
                    const parts = targetPath.split('/'), fn = parts.pop(), fld = parts.pop();
                    if (fld !== 'assets' && fld !== 'pixaroma') fallbacks.push(ext + fld + '/' + fn, ext + 'js/' + fld + '/' + fn);
                }
            }
            for (const fbPath of [...new Set(fallbacks)].filter(f => f !== targetPath)) {
                try { const fbRes = await fetch(`${targetInstance}${fbPath}`, fetchOptions); if (fbRes.ok) { response = fbRes; break; } } catch (e) {}
            }
        }

        if (!response.ok) {
            console.log(`[Proxy] Response: ${response.status} for ${targetPath}`);
        }

        response.headers.forEach((v, n) => { if (!['content-encoding', 'content-length', 'transfer-encoding', 'access-control-allow-origin', 'content-security-policy'].includes(n.toLowerCase())) res.setHeader(n, v); });
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('X-Frame-Options', 'ALLOWALL');
        res.setHeader('Content-Security-Policy', "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;");
        res.status(response.status);
        response.body.pipe(res);
    } catch (error) { if (!res.headersSent) res.status(502).json({ error: 'Bad Gateway' }); }
}

const appShim = `export const app = { registerExtension: (ext) => { if (!window._pixaroma_extensions) window._pixaroma_extensions = {}; window._pixaroma_extensions[ext.name] = ext; }, ui: { settings: { getSettingValue: (id) => JSON.parse(localStorage.getItem('pixaroma_settings') || '{}')[id] || null } } };`;
const apiShim = `export const api = { api_base: '', fetchApi: async (route, options) => fetch(route.startsWith('/') ? route : '/' + route, options) };`;

apps.forEach(app => {
    ['/scripts/app.js', '*/scripts/app.js'].forEach(p => app.get(p, (req, res) => { res.setHeader('Content-Type', 'application/javascript'); res.send(appShim); }));
    ['/scripts/api.js', '*/scripts/api.js'].forEach(p => app.get(p, (req, res) => { res.setHeader('Content-Type', 'application/javascript'); res.send(apiShim); }));
    app.all('/pixaroma/*', proxyToComfy); app.all('/extensions/*', proxyToComfy);
    ['/view', '/prompt', '/history', '/embeddings', '/object_info', '/system_stats', '/queue', '/upload/image', '/ws'].forEach(r => app.all(r, proxyToComfy));
});

// ============ ROUTES ============

adminApp.use(express.static('public')); adminApp.use('/output', express.static('output')); adminApp.use('/uploads', express.static('uploads'));
publicApp.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'public.html')));
publicApp.use(express.static('public')); publicApp.use('/output', express.static('output')); publicApp.use('/uploads', express.static('uploads'));

function reconcileUIConfig(analysis, existingConfig) {
    const config = {
        visibleInputs: existingConfig?.visibleInputs || {},
        visibleParams: existingConfig?.visibleParams || {},
        inputOrder: existingConfig?.inputOrder || [],
        inputNames: existingConfig?.inputNames || {},
        advancedConfig: existingConfig?.advancedConfig || { segmented: false, sceneThreshold: 0.2, fallbackDuration: 10, maxSegmentDuration: 10 }
    };
    const allKeys = [];
    analysis.inputs?.forEach(g => g.inputs.forEach(i => { allKeys.push(i.key); if (config.visibleInputs[i.key] === undefined) config.visibleInputs[i.key] = true; }));
    analysis.advancedInputs?.forEach(g => g.inputs.forEach(p => { allKeys.push(p.key); if (config.visibleParams[p.key] === undefined) config.visibleParams[p.key] = true; }));
    config.inputOrder = [...config.inputOrder.filter(k => allKeys.includes(k)), ...allKeys.filter(k => !config.inputOrder.includes(k))];
    return config;
}

adminApp.get('/api/workflows/list', (req, res) => {
    const savedDir = path.join('workflows', 'saved'); if (!fs.existsSync(savedDir)) return res.json({ workflows: [] });
    const workflows = fs.readdirSync(savedDir).filter(f => f.endsWith('.json')).map(f => { try { const c = JSON.parse(fs.readFileSync(path.join(savedDir, f), 'utf8')); return { id: f.replace('.json', ''), name: c.metadata?.name || f.replace('.json', ''), description: c.metadata?.description || '', createdAt: c.metadata?.createdAt || fs.statSync(path.join(savedDir, f)).mtime }; } catch(e){ return null; } }).filter(w => w).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, workflows });
});

adminApp.post('/api/workflows/load/:id', (req, res) => {
    const file = fs.readdirSync(path.join('workflows', 'saved')).find(f => f.includes(req.params.id)); if (!file) return res.status(404).json({ error: 'Not found' });
    const data = JSON.parse(fs.readFileSync(path.join('workflows', 'saved', file), 'utf8'));
    currentWorkflowData = { raw: data.workflow, analysis: data.analysis, workflowApi: data.analysis.workflowApi || data.workflow };
    currentWorkflowId = req.params.id; uiConfig = reconcileUIConfig(data.analysis, data.uiConfig); originalWorkflowValues = extractOriginalWorkflowValues(currentWorkflowData.workflowApi);
    res.json({ success: true, analysis: data.analysis, metadata: data.metadata, uiConfig, originalValues: originalWorkflowValues });
});

adminApp.post('/api/workflows/save', (req, res) => {
    if (!currentWorkflowData) return res.status(400).json({ error: 'No workflow loaded' });
    const id = generateId(), name = req.body.name, fileName = `${name.replace(/[^a-z0-9]/gi, '_')}_${id}.json`, filePath = path.join('workflows', 'saved', fileName);
    const savedUiConfig = req.body.config || uiConfig;
    fs.writeFileSync(filePath, JSON.stringify({ metadata: { id, name, description: req.body.description || '', createdAt: new Date().toISOString(), presets: req.body.presets || [] }, workflow: currentWorkflowData.raw, analysis: currentWorkflowData.analysis, uiConfig: savedUiConfig }, null, 2));
    currentWorkflowId = id;
    uiConfig = savedUiConfig; // Ensure server-side state is updated
    res.json({ success: true, id, name });
});

adminApp.delete('/api/workflows/delete/:id', (req, res) => {
    const file = fs.readdirSync(path.join('workflows', 'saved')).find(f => f.includes(req.params.id)); if (file) fs.unlinkSync(path.join('workflows', 'saved', file));
    res.json({ success: true });
});

adminApp.post('/api/workflow/upload', upload.single('workflow'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const json = JSON.parse(fs.readFileSync(req.file.path, 'utf8')), analysis = analyzeWorkflow(json);
    currentWorkflowData = { raw: json, analysis, workflowApi: analysis.workflowApi }; originalWorkflowValues = extractOriginalWorkflowValues(currentWorkflowData.workflowApi);
    uiConfig = { visibleInputs: {}, visibleParams: {}, inputOrder: [], inputNames: {} };
    analysis.inputs?.forEach(g => g.inputs.forEach(i => { uiConfig.visibleInputs[i.key] = true; uiConfig.inputOrder.push(i.key); }));
    analysis.advancedInputs?.forEach(g => g.inputs.forEach(p => { uiConfig.visibleParams[p.key] = true; uiConfig.inputOrder.push(p.key); }));
    fs.unlinkSync(req.file.path); res.json({ success: true, analysis, originalValues: originalWorkflowValues, uiConfig });
});

adminApp.post('/api/config/save', (req, res) => {
    uiConfig = req.body.config;
    if (currentWorkflowId) {
        const file = fs.readdirSync(path.join('workflows', 'saved')).find(f => f.includes(currentWorkflowId));
        if (file) { const d = JSON.parse(fs.readFileSync(path.join('workflows', 'saved', file), 'utf8')); d.uiConfig = uiConfig; fs.writeFileSync(path.join('workflows', 'saved', file), JSON.stringify(d, null, 2)); }
    }
    fs.writeFileSync(path.join('workflows', 'ui_config.json'), JSON.stringify(uiConfig, null, 2)); res.json({ success: true });
});

const handleChunkUpload = async (req, res) => {
    try {
        const { uploadId, chunkIndex, totalChunks, filename } = req.body;
        if (!req.file) return res.status(400).json({ error: 'No chunk file' });

        // SECURITY: Validate uploadId to prevent path traversal
        if (!uploadId || !/^[a-z0-9-]+$/i.test(uploadId)) {
            return res.status(400).json({ error: 'Invalid upload ID' });
        }

        const chunkDir = path.join('uploads', 'chunks', uploadId);
        if (!fs.existsSync(chunkDir)) fs.mkdirSync(chunkDir, { recursive: true });

        const chunkPath = path.join(chunkDir, `chunk-${chunkIndex}`);
        try {
            fs.renameSync(req.file.path, chunkPath);
        } catch (e) {
            fs.copyFileSync(req.file.path, chunkPath);
            fs.unlinkSync(req.file.path);
        }

        const receivedChunks = fs.readdirSync(chunkDir).length;
        if (receivedChunks === parseInt(totalChunks)) {
            const finalFn = `${generateId()}${path.extname(filename)}`;
            const finalPath = path.join('uploads', 'media', finalFn);
            const writeStream = fs.createWriteStream(finalPath);

            const sortedChunks = fs.readdirSync(chunkDir).sort((a, b) => {
                return parseInt(a.split('-')[1]) - parseInt(b.split('-')[1]);
            });

            for (const chunkFile of sortedChunks) {
                const partPath = path.join(chunkDir, chunkFile);
                await new Promise((resolve, reject) => {
                    const readStream = fs.createReadStream(partPath);
                    readStream.pipe(writeStream, { end: false });
                    readStream.on('end', resolve);
                    readStream.on('error', reject);
                });
            }
            writeStream.end();

            await new Promise((resolve, reject) => {
                writeStream.on('finish', resolve);
                writeStream.on('error', reject);
            });

            mediaStore[finalFn] = { path: finalPath, originalName: filename, mimetype: filename.endsWith('.mp4') ? 'video/mp4' : 'image/png' };

            // Cleanup
            fs.rmSync(chunkDir, { recursive: true, force: true });

            return res.json({ success: true, filename: finalFn, type: finalFn.endsWith('.mp4') ? 'video' : 'image', completed: true, url: `/uploads/media/${finalFn}` });
        }

        res.json({ success: true, chunkIndex, completed: false });
    } catch (e) {
        console.error('Chunk upload error:', e);
        res.status(500).json({ error: e.message });
    }
};

adminApp.post('/api/upload/chunk', upload.single('chunk'), handleChunkUpload);
publicApp.post('/api/upload/chunk', upload.single('chunk'), handleChunkUpload);

adminApp.post('/api/upload/media/:inputKey', upload.single('media'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file' });
        const fn = `${generateId()}${path.extname(req.file.originalname)}`, p = path.join('uploads', 'media', fn);
        try {
            fs.renameSync(req.file.path, p);
        } catch (e) {
            fs.copyFileSync(req.file.path, p);
            fs.unlinkSync(req.file.path);
        }
        mediaStore[fn] = { path: p, originalName: req.file.originalname, mimetype: req.file.mimetype };
        res.json({ success: true, filename: fn, type: req.file.mimetype.startsWith('video/') ? 'video' : 'image', url: `/uploads/media/${fn}` });
    } catch (e) {
        console.error('Upload API error:', e);
        res.status(500).json({ error: e.message });
    }
});

async function runWorkflowLogic(req, res, isPublic = false) {
    try {
        const { mediaFiles, parameters, bypassedNodes, workflowId } = req.body;
        let workflow, analysis;
        if (isPublic) {
            const file = fs.readdirSync(path.join('workflows', 'saved')).find(f => f.includes(workflowId)); if (!file) throw new Error('Not found');
            const d = JSON.parse(fs.readFileSync(path.join('workflows', 'saved', file), 'utf8'));
            workflow = JSON.parse(JSON.stringify(d.analysis.workflowApi || d.workflow)); analysis = d.analysis;
        } else {
            if (!currentWorkflowData) throw new Error('No workflow');
            workflow = JSON.parse(JSON.stringify(currentWorkflowData.workflowApi)); analysis = currentWorkflowData.analysis;
        }
        const target = await getFreestInstance(); workflow = applyBypass(workflow, bypassedNodes);

        // ALWAYS filter out trigger buttons from Pixaroma nodes in the outgoing prompt
        Object.values(workflow).forEach(node => {
            if (node.class_type?.startsWith('Pixaroma') && node.inputs) {
                Object.keys(node.inputs).forEach(key => { if (key.startsWith('Open')) delete node.inputs[key]; });
            }
        });

        for (const [k, fn] of Object.entries(mediaFiles || {})) {
            let finalFn = fn; if (mediaStore[fn]) finalFn = (await uploadFileToInstance(target, mediaStore[fn].path, mediaStore[fn].originalName, mediaStore[fn].mimetype)).name;
            analysis.inputs?.forEach(g => g.inputs?.forEach(i => { if (i.key === k && workflow[i.nodeId]) workflow[i.nodeId].inputs[i.inputName] = finalFn; }));
        }

        let baseParams = {};
        if (isPublic) baseParams = extractOriginalWorkflowValues(workflow);
        else if (currentWorkflowId) {
            const file = fs.readdirSync(path.join('workflows', 'saved')).find(f => f.includes(currentWorkflowId));
            if (file) { const data = JSON.parse(fs.readFileSync(path.join('workflows', 'saved', file), 'utf8')); baseParams = extractOriginalWorkflowValues(data.analysis.workflowApi || data.workflow); }
            else baseParams = originalWorkflowValues;
        }

        const finalParams = { ...baseParams, ...parameters };
        const auto = parameters?.['_autoRandomSeed'] || {};

        for (const [pk, v] of Object.entries(finalParams)) {
            if (shouldGenerateRandomSeed(pk, v, auto)) finalParams[pk] = generateRandomSeed();
            analysis.advancedInputs.forEach(g => g.inputs?.forEach(p => {
                if (p.key === pk && workflow[p.nodeId]) {
                    if (p.nodeType?.startsWith('Pixaroma') && p.inputName?.startsWith('Open')) return;
                    let fv = finalParams[pk];
                    if (p.valueType === 'number') fv = parseFloat(fv);
                    else if (p.valueType === 'boolean') fv = (fv === 'true' || fv === true);
                    else if (p.valueType === 'pixaroma_editor') {
                        // CRITICAL: Force STRING for API submission.
                        // Many custom nodes fail if they get an object when expecting a JSON string.
                        if (typeof fv === 'object') fv = JSON.stringify(fv);
                        else if (typeof fv === 'string' && (fv.startsWith('{') || fv.startsWith('['))) {
                            // Already a JSON string, ensure it's not double-stringified
                            try {
                                const parsed = JSON.parse(fv);
                                fv = JSON.stringify(parsed);
                            } catch(e) {}
                        }
                    }
                    workflow[p.nodeId].inputs[p.inputName] = fv;
                    if (p.valueType === 'pixaroma_editor') {
                        console.log(`[Run] Applied Pixaroma ${p.nodeId}.${p.inputName}:`, (typeof fv === 'string' && fv.length > 50) ? fv.substring(0, 50) + '...' : fv);
                    }
                }
            }));
        }

        const { workflow: vw } = validateWorkflowParameters(workflow);
        console.log('[Run] Submitting prompt...');

        const qRes = await fetch(`${target}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: vw }) });
        const qData = await qRes.json(); if (qData.error) throw new Error(qData.error.message || JSON.stringify(qData.error));
        console.log(`[Run] Accepted ID: ${qData.prompt_id}`);

        let result = null, attempts = 0;
        while (!result && attempts < 180) { await new Promise(r => setTimeout(r, 2000)); const h = await (await fetch(`${target}/history`)).json(); if (h[qData.prompt_id]) { result = h[qData.prompt_id]; break; } attempts++; }
        if (!result) throw new Error('Timeout');
        const outputFiles = [];
        for (const [nodeId, output] of Object.entries(result.outputs || {})) {
            for (const item of [...(output.images || []), ...(output.videos || [])]) {
                const fileRes = await fetch(`${target}/view?filename=${encodeURIComponent(item.filename)}&type=${item.type}&subfolder=${item.subfolder || ''}`);
                const localFn = `${generateId()}${path.extname(item.filename) || (item.type === 'video' ? '.mp4' : '.png')}`;
                fs.writeFileSync(path.join('output', localFn), await fileRes.buffer());
                outputFiles.push({ filename: localFn, url: `/output/${localFn}`, type: item.type === 'video' || localFn.endsWith('.mp4') ? 'video' : 'image' });
            }
        }
        res.json({ success: true, files: outputFiles });
    } catch (e) { res.status(500).json({ error: e.message }); }
}

adminApp.post('/api/workflows/save-parameters', (req, res) => {
    try {
        const { workflowId, parameters } = req.body;
        if (!workflowId) return res.status(400).json({ error: 'ID missing' });
        const file = fs.readdirSync(path.join('workflows', 'saved')).find(f => f.includes(workflowId));
        if (!file) return res.status(404).json({ error: 'Not found' });
        const filePath = path.join(savedDir = path.join('workflows', 'saved'), file), data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (data.analysis?.workflowApi) {
            const workflow = data.analysis.workflowApi;
            Object.entries(parameters || {}).forEach(([key, value]) => {
                const parts = key.split('_');
                if (parts[0] === 'node' && parts.length >= 3) {
                    const nodeId = parts[1], inputName = parts.slice(2).join('_');
                    if (workflow[nodeId]?.inputs) {
                        let finalValue = value;
                        if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) { try { finalValue = JSON.parse(value); } catch(e){} }
                        workflow[nodeId].inputs[inputName] = finalValue;
                        if (currentWorkflowId && workflowId.includes(currentWorkflowId)) {
                            originalWorkflowValues[key] = value;
                            if (currentWorkflowData?.workflowApi?.[nodeId]) currentWorkflowData.workflowApi[nodeId].inputs[inputName] = finalValue;
                        }
                    }
                }
            });
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
            return res.json({ success: true });
        }
        res.status(400).json({ error: 'Missing analysis' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

adminApp.post('/api/workflow/run', (req, res) => runWorkflowLogic(req, res));
publicApp.post('/api/workflow/run', (req, res) => runWorkflowLogic(req, res, true));

async function runSingleSegment(segmentPath, workflowId, parameters, bypassedNodes, targetInstance, extraSegments = {}) {
    // 1. Upload primary segment to instance
    const uploadRes = await uploadFileToInstance(targetInstance, segmentPath, path.basename(segmentPath), 'video/mp4');
    const primaryFilename = uploadRes.name;

    const segmentMap = { ...extraSegments };
    // Also upload extra segments
    for (const [key, p] of Object.entries(segmentMap)) {
        const res = await uploadFileToInstance(targetInstance, p, path.basename(p), 'video/mp4');
        segmentMap[key] = res.name;
    }

    // 2. Prepare workflow
    let workflow, analysis;
    const file = workflowId ? fs.readdirSync(path.join('workflows', 'saved')).find(f => f.includes(workflowId)) : null;
    if (file) {
        const d = JSON.parse(fs.readFileSync(path.join('workflows', 'saved', file), 'utf8'));
        workflow = JSON.parse(JSON.stringify(d.analysis.workflowApi || d.workflow));
        analysis = d.analysis;
    } else if (currentWorkflowData) {
        workflow = JSON.parse(JSON.stringify(currentWorkflowData.workflowApi));
        analysis = currentWorkflowData.analysis;
    } else {
        throw new Error('Workflow not found for segmentation');
    }

    workflow = applyBypass(workflow, bypassedNodes);

    // Map segment filename to all video inputs
    analysis.inputs?.forEach(g => g.inputs?.forEach(i => {
        if (i.valueType === 'video' && workflow[i.nodeId]) {
            workflow[i.nodeId].inputs[i.inputName] = segmentMap[i.key] || primaryFilename;
        }
    }));

    const finalParams = { ...extractOriginalWorkflowValues(workflow), ...parameters };
    const auto = parameters?.['_autoRandomSeed'] || {};

    for (const [pk, v] of Object.entries(finalParams)) {
        if (shouldGenerateRandomSeed(pk, v, auto)) finalParams[pk] = generateRandomSeed();
        analysis.advancedInputs.forEach(g => g.inputs?.forEach(p => {
            if (p.key === pk && workflow[p.nodeId]) {
                let fv = finalParams[pk];
                if (p.valueType === 'number') fv = parseFloat(fv);
                else if (p.valueType === 'boolean') fv = (fv === 'true' || fv === true);
                workflow[p.nodeId].inputs[p.inputName] = fv;
            }
        }));
    }

    const { workflow: vw } = validateWorkflowParameters(workflow);
    const qRes = await fetch(`${targetInstance}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: vw }) });
    const qData = await qRes.json();
    if (qData.error) throw new Error(qData.error.message || JSON.stringify(qData.error));

    let result = null, attempts = 0;
    while (!result && attempts < 300) { // 10 min timeout
        await new Promise(r => setTimeout(r, 2000));
        const h = await (await fetch(`${targetInstance}/history`)).json();
        if (h[qData.prompt_id]) result = h[qData.prompt_id];
        attempts++;
    }

    if (!result) throw new Error(`Segment timeout after 10 minutes (ID: ${qData.prompt_id})`);

    // Download result
    let outputFn = null;
    for (const [nodeId, output] of Object.entries(result.outputs || {})) {
        const item = (output.videos || output.images || output.gifs || [])[0];
        if (item) {
            const fileRes = await fetch(`${targetInstance}/view?filename=${encodeURIComponent(item.filename)}&type=${item.type}&subfolder=${item.subfolder || ''}`);
            if (!fileRes.ok) throw new Error(`Failed to download result for segment: ${fileRes.status}`);
            outputFn = path.join('temp_segments', `processed_${generateId()}.mp4`);
            fs.writeFileSync(outputFn, await fileRes.buffer());
            break;
        }
    }

    if (!outputFn) {
        console.error(`[Segmented] Node outputs missing for ${qData.prompt_id}:`, JSON.stringify(result.outputs));
        throw new Error(`Segment produced no output files (Prompt ID: ${qData.prompt_id})`);
    }

    return outputFn;
}

const preSegmentHandler = async (req, res) => {
    try {
        const { filename, advancedConfig } = req.body;
        let inputVideo = path.join('uploads', 'media', filename);
        if (!fs.existsSync(inputVideo)) {
            inputVideo = path.join('output', filename);
        }
        if (!fs.existsSync(inputVideo)) throw new Error('File not found');

        const runId = generateId();
        const segmentDir = path.join('temp_segments', runId);
        fs.mkdirSync(segmentDir, { recursive: true });

        const sceneThreshold = advancedConfig?.sceneThreshold ?? 0.2;
        const maxSegmentDuration = advancedConfig?.maxSegmentDuration ?? 5;
        const segmentOverlap = advancedConfig?.segmentOverlap ?? 2;

        // 1. Detect scene changes
        const sceneChangeFile = path.join(segmentDir, 'scenes.txt');
        await new Promise((resolve, reject) => {
            ffmpeg(inputVideo)
                .outputOptions(['-vf', `select='gt(scene,${sceneThreshold})',showinfo`, '-f', 'null'])
                .output('-')
                .on('stderr', (line) => {
                    const match = line.match(/pts_time:([\d.]+)/);
                    if (match) fs.appendFileSync(sceneChangeFile, match[1] + ',');
                })
                .on('end', resolve)
                .on('error', reject)
                .run();
        });

        let segmentTimes = [];
        if (fs.existsSync(sceneChangeFile)) {
            segmentTimes = fs.readFileSync(sceneChangeFile, 'utf8').split(',').filter(t => t.trim()).map(t => parseFloat(t));
        }

        const videoDuration = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(inputVideo, (err, metadata) => {
                if (err) reject(err); else resolve(metadata.format.duration);
            });
        });

        const refinedTimes = [];
        let lastTime = 0;
        const allPotentialSplits = [...new Set([...segmentTimes, videoDuration])].sort((a, b) => a - b);
        for (const splitTime of allPotentialSplits) {
            while (splitTime - lastTime > maxSegmentDuration + 0.1) {
                lastTime += maxSegmentDuration;
                refinedTimes.push(lastTime);
            }
            if (splitTime < videoDuration && splitTime > lastTime + 0.1) {
                lastTime = splitTime;
                refinedTimes.push(lastTime);
            }
        }

        const overlappingSegments = [];
        if (videoDuration > maxSegmentDuration) {
            let start = 0;
            const safeOverlap = Math.max(0, Math.min(segmentOverlap, maxSegmentDuration - 0.5));
            while (start < videoDuration) {
                let end = Math.min(start + maxSegmentDuration, videoDuration);
                overlappingSegments.push({ start, duration: end - start });
                if (end >= videoDuration) break;
                let nextStart = end - safeOverlap;
                if (nextStart <= start) nextStart = start + 1; // absolute progress safety
                start = nextStart;
            }
        } else {
            overlappingSegments.push({ start: 0, duration: videoDuration });
        }

        for (let i = 0; i < overlappingSegments.length; i++) {
            const seg = overlappingSegments[i];
            await new Promise((resolve, reject) => {
                ffmpeg(inputVideo)
                    .setStartTime(seg.start)
                    .setDuration(seg.duration)
                    .outputOptions([
                        '-map 0',
                        '-c:v libx264',
                        '-preset superfast',
                        '-crf 18',
                        '-c:a aac',
                        '-avoid_negative_ts make_zero'
                    ])
                    .output(path.join(segmentDir, `seg_${String(i).padStart(3, '0')}.mp4`))
                    .on('end', resolve)
                    .on('error', reject)
                    .run();
            });
        }

        const segments = fs.readdirSync(segmentDir).filter(f => f.startsWith('seg_')).sort();
        res.json({ success: true, runId, segments });
    } catch (e) { res.status(500).json({ error: e.message }); }
};

const processSegmentedHandler = async (req, res) => {
    const { mediaFiles, parameters, bypassedNodes, workflowId, advancedConfig, runId, segmentedInputs } = req.body;
    const currentId = workflowId || currentWorkflowId;

    // Ensure we have some workflow reference
    if (!currentId && !currentWorkflowData) return res.status(400).json({ error: 'No workflow' });

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendUpdate = (data) => {
        if (!res.writableEnded) {
            res.write(JSON.stringify(data) + '\n');
        }
    };

    // Heartbeat to keep connection alive
    const heartbeat = setInterval(() => sendUpdate({ type: 'heartbeat' }), 15000);

    const sceneThreshold = advancedConfig?.sceneThreshold ?? 0.2;
    const maxSegmentDuration = advancedConfig?.maxSegmentDuration ?? 5;
    const segmentOverlap = advancedConfig?.segmentOverlap ?? 2;

    try {
        let activeRunId = runId || (segmentedInputs ? Object.values(segmentedInputs)[0] : null);
        let segmentDir = activeRunId ? path.join('temp_segments', activeRunId) : null;
        let segments = [];

        if (!activeRunId) {
            const videoKey = Object.keys(mediaFiles || {}).find(k => k.startsWith('media_') || k.includes('file') || k.includes('video'));
            if (!videoKey) throw new Error('No video input found for segmented processing');

            let inputVideo = path.join('uploads', 'media', mediaFiles[videoKey]);
            if (!fs.existsSync(inputVideo)) {
                inputVideo = path.join('output', mediaFiles[videoKey]);
            }
            if (!fs.existsSync(inputVideo)) {
                const fn = mediaFiles[videoKey];
                if (mediaStore[fn]) inputVideo = mediaStore[fn].path;
                else throw new Error(`Video file not found: ${fn}`);
            }

            activeRunId = generateId();
            segmentDir = path.join('temp_segments', activeRunId);
            fs.mkdirSync(segmentDir, { recursive: true });

            sendUpdate({ status: 'Analyzing & Segmenting...' });

            const sceneChangeFile = path.join(segmentDir, 'scenes.txt');
            await new Promise((resolve, reject) => {
                ffmpeg(inputVideo).outputOptions(['-vf', `select='gt(scene,${sceneThreshold})',showinfo`, '-f', 'null']).output('-')
                    .on('stderr', line => { const m = line.match(/pts_time:([\d.]+)/); if (m) fs.appendFileSync(sceneChangeFile, m[1] + ','); })
                    .on('end', resolve).on('error', reject).run();
            });

            let segmentTimes = [];
            if (fs.existsSync(sceneChangeFile)) { segmentTimes = fs.readFileSync(sceneChangeFile, 'utf8').split(',').filter(t => t.trim()).map(t => parseFloat(t)); }
            const videoDuration = await new Promise((res, rej) => { ffmpeg.ffprobe(inputVideo, (err, m) => err ? rej(err) : res(m.format.duration)); });

            const refinedTimes = []; let lastTime = 0;
            const allSplits = [...new Set([...segmentTimes, videoDuration])].sort((a, b) => a - b);
            for (const st of allSplits) {
                while (st - lastTime > maxSegmentDuration + 0.1) { lastTime += maxSegmentDuration; refinedTimes.push(lastTime); }
                if (st < videoDuration && st > lastTime + 0.1) { lastTime = st; refinedTimes.push(lastTime); }
            }

            const overlappingSegments = [];

            if (videoDuration > maxSegmentDuration) {
                let start = 0;
                const safeOverlap = Math.max(0, Math.min(segmentOverlap, maxSegmentDuration - 0.5));
                while (start < videoDuration) {
                    let end = Math.min(start + maxSegmentDuration, videoDuration);
                    overlappingSegments.push({ start, duration: end - start });
                    if (end >= videoDuration) break;
                    let nextStart = end - safeOverlap;
                    if (nextStart <= start) nextStart = start + 1; // absolute progress safety
                    start = nextStart;
                }
            } else {
                overlappingSegments.push({ start: 0, duration: videoDuration });
            }

            for (let i = 0; i < overlappingSegments.length; i++) {
                const seg = overlappingSegments[i];
                await new Promise((resolve, reject) => {
                    ffmpeg(inputVideo)
                        .setStartTime(seg.start)
                        .setDuration(seg.duration)
                        .outputOptions([
                            '-map 0',
                            '-c:v libx264',
                            '-preset superfast',
                            '-crf 18',
                            '-c:a aac',
                            '-avoid_negative_ts make_zero'
                        ])
                        .output(path.join(segmentDir, `seg_${String(i).padStart(3, '0')}.mp4`))
                        .on('end', resolve)
                        .on('error', reject)
                        .run();
                });
            }
        }

        segments = fs.readdirSync(segmentDir).filter(f => f.startsWith('seg_')).sort().map(f => path.join(segmentDir, f));
        const processedSegments = [];
        const target = await getFreestInstance();
        console.log(`[Segmented] Starting processing of ${segments.length} segments on ${target}`);

        for (let i = 0; i < segments.length; i++) {
            if (activeRunId && cancelledRuns.has(activeRunId)) {
                cancelledRuns.delete(activeRunId);
                throw new Error('Processing cancelled by user');
            }
            const progressPercent = Math.round(((i + 1) / segments.length) * 100);
            sendUpdate({
                status: `Processing segment ${i + 1}/${segments.length}...`,
                progress: { current: i + 1, total: segments.length, percent: progressPercent }
            });

            const extraSegments = {};
            if (segmentedInputs) {
                Object.entries(segmentedInputs).forEach(([inputKey, rId]) => {
                    const otherDir = path.join('temp_segments', rId);
                    const otherSegments = fs.readdirSync(otherDir).filter(f => f.startsWith('seg_')).sort();
                    if (otherSegments[i]) {
                        extraSegments[inputKey] = path.join(otherDir, otherSegments[i]);
                    }
                });
            }

            console.log(`[Segmented] Processing segment ${i + 1}/${segments.length}: ${segments[i]}`);
            try {
                const processed = await runSingleSegment(segments[i], currentId, parameters, bypassedNodes, target, extraSegments);
                if (processed) {
                    processedSegments.push(processed);
                    console.log(`[Segmented] Finished segment ${i + 1}: ${processed}`);
                }
            } catch (segErr) {
                console.error(`[Segmented] Segment ${i + 1} failed:`, segErr.message);
                sendUpdate({ status: `Segment ${i + 1} failed, skipping...`, error: segErr.message });
            }
        }

        sendUpdate({ status: 'Reassembling with cross-fades...' });

        if (processedSegments.length === 0) {
            throw new Error('All segments failed to process. Cannot reassemble.');
        }

        const finalName = `upscaled_${generateId()}.mp4`;
        const finalPath = path.join('output', finalName);
        console.log(`[Segmented] Reassembling ${processedSegments.length} segments into ${finalPath}`);

        if (processedSegments.length > 1 && segmentOverlap > 0) {
            const cmd = ffmpeg();
            processedSegments.forEach(p => cmd.input(p));

            let filterGraph = '';
            let offset = 0;

            // Get actual durations and resolutions of processed segments to be precise
            const durations = [];
            const resolutions = [];
            for (const p of processedSegments) {
                const metadata = await new Promise((res) => {
                    ffmpeg.ffprobe(p, (err, m) => res(m));
                });
                durations.push(metadata?.format?.duration || maxSegmentDuration);
                const stream = metadata?.streams?.find(s => s.codec_type === 'video');
                resolutions.push({ width: stream?.width || 0, height: stream?.height || 0 });
            }

            // Target resolution is the maximum found among segments
            const targetWidth = Math.max(...resolutions.map(r => r.width));
            const targetHeight = Math.max(...resolutions.map(r => r.height));

            // Pre-process all inputs to the same resolution and pixel format
            processedSegments.forEach((p, i) => {
                filterGraph += `[${i}:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,format=yuv420p[pv${i}]; `;
            });

            // [pv0][pv1]xfade=transition=fade:duration=2:offset=3[v1];
            // [v1][pv2]xfade=transition=fade:duration=2:offset=6[v2]
            for (let i = 0; i < processedSegments.length - 1; i++) {
                const fadeDuration = segmentOverlap;
                if (i === 0) {
                    offset = durations[0] - fadeDuration;
                    filterGraph += `[pv0][pv1]xfade=transition=fade:duration=${fadeDuration}:offset=${offset}[v1]; `;
                    filterGraph += `[0:a][1:a]acrossfade=d=${fadeDuration}[a1]; `;
                } else {
                    offset = offset + durations[i] - fadeDuration;
                    filterGraph += `[v${i}][pv${i + 1}]xfade=transition=fade:duration=${fadeDuration}:offset=${offset}[v${i + 1}]; `;
                    filterGraph += `[a${i}][${i + 1}:a]acrossfade=d=${fadeDuration}[a${i + 1}]; `;
                }
            }

            const lastIdx = processedSegments.length - 1;
            await new Promise((resolve, reject) => {
                cmd.complexFilter(filterGraph.trim())
                    .map(`[v${lastIdx}]`)
                    .map(`[a${lastIdx}]`)
                    .videoCodec('libx264')
                    .audioCodec('aac')
                    .outputOptions(['-pix_fmt yuv420p', '-crf 18'])
                    .save(finalPath)
                    .on('end', resolve)
                    .on('error', (err) => {
                        console.error('Xfade failed, falling back to basic concat:', err);
                        // Fallback logic
                        const listFile = path.join(segmentDir, 'list_fallback.txt');
                        fs.writeFileSync(listFile, processedSegments.map(p => `file '${path.resolve(p)}'`).join('\n'));
                        ffmpeg().input(listFile).inputOptions(['-f concat', '-safe 0']).videoCodec('libx264').audioCodec('aac').save(finalPath).on('end', resolve).on('error', reject);
                    });
            });
        } else {
            const listFile = path.join(segmentDir, 'list.txt');
            fs.writeFileSync(listFile, processedSegments.map(p => `file '${path.resolve(p)}'`).join('\n'));
            await new Promise((resolve, reject) => {
                ffmpeg()
                    .input(listFile)
                    .inputOptions(['-f concat', '-safe 0'])
                    .outputOptions('-c copy')
                    .save(finalPath)
                    .on('end', resolve)
                    .on('error', (err) => {
                        ffmpeg()
                            .input(listFile)
                            .inputOptions(['-f concat', '-safe 0'])
                            .videoCodec('libx264')
                            .audioCodec('aac')
                            .outputOptions('-pix_fmt yuv420p')
                            .save(finalPath)
                            .on('end', resolve)
                            .on('error', reject);
                    });
            });
        }

        console.log(`[Segmented] Successfully created final video: ${finalPath}`);
        sendUpdate({
            success: true,
            files: [{ filename: finalName, url: `/output/${finalName}`, type: 'video' }],
            progress: { current: segments.length, total: segments.length, percent: 100 }
        });

        clearInterval(heartbeat);
        res.end();

        // Cleanup
        setTimeout(() => fs.rmSync(segmentDir, { recursive: true, force: true }), 60000);
    } catch (e) {
        console.error('[Segmented] Error during processing:', e);
        clearInterval(heartbeat);
        sendUpdate({ error: e.message });
        res.end();
    }
};

adminApp.post('/api/video/pre-segment', preSegmentHandler);
adminApp.post('/api/video/process-segmented', processSegmentedHandler);
adminApp.post('/api/video/cancel-segmented', (req, res) => {
    const { runId } = req.body;
    if (runId) cancelledRuns.add(runId);
    res.json({ success: true });
});
adminApp.post('/api/workflow/interrupt', async (req, res) => {
    try {
        const target = await getFreestInstance();
        await fetch(`${target}/interrupt`, { method: 'POST' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

publicApp.post('/api/video/pre-segment', preSegmentHandler);
publicApp.post('/api/video/process-segmented', processSegmentedHandler);
publicApp.post('/api/video/cancel-segmented', (req, res) => {
    const { runId } = req.body;
    if (runId) cancelledRuns.add(runId);
    res.json({ success: true });
});
publicApp.post('/api/workflow/interrupt', async (req, res) => {
    try {
        const target = await getFreestInstance();
        await fetch(`${target}/interrupt`, { method: 'POST' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

adminApp.get('/api/config', (req, res) => res.json({ adminPort: ADMIN_PORT, publicPort: PUBLIC_PORT, comfyuiUrls: COMFYUI_URLS }));
adminApp.post('/api/settings', (req, res) => { COMFYUI_URLS = req.body.comfyuiUrls; CONFIG.COMFYUI_URLS = COMFYUI_URLS; fs.writeFileSync(CONFIG_FILE, JSON.stringify(CONFIG, null, 2)); res.json({ success: true }); });
function safeJoin(base, ...parts) {
    const resolvedBase = path.resolve(base);
    const joined = path.resolve(path.join(resolvedBase, ...parts));
    if (!joined.startsWith(resolvedBase)) throw new Error('Path traversal attempt');
    return joined;
}

adminApp.delete('/api/outputs', (req, res) => {
    try {
        const filename = req.query.filename;
        if (!filename) throw new Error('Filename required');
        const p = safeJoin('output', filename);
        if (fs.existsSync(p)) {
            if (fs.statSync(p).isDirectory()) fs.rmSync(p, { recursive: true });
            else fs.unlinkSync(p);
        }
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

adminApp.get('/api/outputs', (req, res) => {
    try {
        const subPath = req.query.path || '';
        const fullPath = safeJoin('output', subPath);
        if (!fs.existsSync(fullPath)) return res.json({ files: [] });

        const files = fs.readdirSync(fullPath).map(f => {
            const p = path.join(fullPath, f);
            const stats = fs.statSync(p);
            const isFolder = stats.isDirectory();
            const ext = path.extname(f).toLowerCase();
            return {
                name: f,
                url: `/output/${path.join(subPath, f).replace(/\\/g, '/')}`,
                type: isFolder ? 'folder' : (['.mp4', '.webm'].includes(ext) ? 'video' : 'image'),
                mtime: stats.mtime,
                isFolder
            };
        }).filter(f => f.isFolder || ['.png', '.jpg', '.jpeg', '.mp4', '.webm', '.gif'].includes(path.extname(f.name).toLowerCase()))
          .sort((a, b) => {
              if (a.isFolder && !b.isFolder) return -1;
              if (!a.isFolder && b.isFolder) return 1;
              return b.mtime - a.mtime;
          });
        res.json({ files });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

adminApp.post('/api/outputs/mkdir', (req, res) => {
    try {
        const { path: subPath, name } = req.body;
        if (!name || name.includes('/') || name.includes('\\') || name === '..') throw new Error('Invalid folder name');
        const p = safeJoin('output', subPath || '', name);
        if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

adminApp.post('/api/outputs/rename', (req, res) => {
    try {
        const { path: subPath, oldName, newName } = req.body;
        if (!newName || newName.includes('/') || newName.includes('\\') || newName === '..') throw new Error('Invalid name');
        const oldP = safeJoin('output', subPath || '', oldName);
        const newP = safeJoin('output', subPath || '', newName);
        fs.renameSync(oldP, newP);
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

adminApp.post('/api/outputs/delete-batch', (req, res) => {
    try {
        const { path: subPath, items } = req.body;
        items.forEach(name => {
            const p = safeJoin('output', subPath || '', name);
            if (fs.existsSync(p)) {
                if (fs.statSync(p).isDirectory()) fs.rmSync(p, { recursive: true });
                else fs.unlinkSync(p);
            }
        });
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

adminApp.post('/api/outputs/move', (req, res) => {
    try {
        const { sourcePath, items, targetPath } = req.body;
        const targetDir = safeJoin('output', targetPath || '');
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

        items.forEach(name => {
            const oldP = safeJoin('output', sourcePath || '', name);
            const newP = safeJoin('output', targetPath || '', name);
            if (fs.existsSync(oldP)) fs.renameSync(oldP, newP);
        });
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

adminApp.get('/api/health', async (req, res) => { const inst = await Promise.all(COMFYUI_URLS.map(async u => { try { return { url: u, status: (await fetch(`${u}/system_stats`, { timeout: 2000 })).ok ? 'connected' : 'disconnected' }; } catch(e){ return { url: u, status: 'disconnected' }; } })); res.json({ status: inst.some(i => i.status === 'connected') ? 'ok' : 'error', comfyui: inst.some(i => i.status === 'connected') ? 'connected' : 'disconnected', instances: inst }); });

publicApp.get('/api/workflows/list', (req, res) => {
    const savedDir = path.join('workflows', 'saved'); if (!fs.existsSync(savedDir)) return res.json({ workflows: [] });
    res.json({ success: true, workflows: fs.readdirSync(savedDir).filter(f => f.endsWith('.json')).map(f => { try { const c = JSON.parse(fs.readFileSync(path.join(savedDir, f), 'utf8')); return { id: f.replace('.json', ''), name: c.metadata?.name || f.replace('.json', ''), description: c.metadata?.description || '' }; } catch(e){ return null; } }).filter(w => w) });
});
publicApp.post('/api/workflows/load/:id', (req, res) => {
    const file = fs.readdirSync(path.join('workflows', 'saved')).find(f => f.includes(req.params.id)); if (!file) return res.status(404).json({ error: 'Not found' });
    const d = JSON.parse(fs.readFileSync(path.join('workflows', 'saved', file), 'utf8'));
    res.json({ success: true, analysis: d.analysis, presets: d.metadata?.presets || [], uiConfig: reconcileUIConfig(d.analysis, d.uiConfig), originalValues: extractOriginalWorkflowValues(d.analysis.workflowApi) });
});
publicApp.post('/api/upload/media/:inputKey', upload.single('media'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file' });
        const fn = `${generateId()}${path.extname(req.file.originalname)}`, p = path.join('uploads', 'media', fn);
        try {
            fs.renameSync(req.file.path, p);
        } catch (e) {
            fs.copyFileSync(req.file.path, p);
            fs.unlinkSync(req.file.path);
        }
        mediaStore[fn] = { path: p, originalName: req.file.originalname, mimetype: req.file.mimetype };
        res.json({ success: true, filename: fn, type: req.file.mimetype.startsWith('video/') ? 'video' : 'image', url: `/uploads/media/${fn}` });
    } catch (e) {
        console.error('Public Upload API error:', e);
        res.status(500).json({ error: e.message });
    }
});
publicApp.get('/api/config', (req, res) => res.json({ adminPort: ADMIN_PORT, publicPort: PUBLIC_PORT, comfyuiUrls: COMFYUI_URLS }));
publicApp.get('/api/outputs', (req, res) => {
    try {
        const subPath = req.query.path || '';
        const fullPath = safeJoin('output', subPath);
        if (!fs.existsSync(fullPath)) return res.json({ files: [] });

        const files = fs.readdirSync(fullPath).map(f => {
            const p = path.join(fullPath, f);
            const stats = fs.statSync(p);
            const isFolder = stats.isDirectory();
            const ext = path.extname(f).toLowerCase();
            return {
                name: f,
                url: `/output/${path.join(subPath, f).replace(/\\/g, '/')}`,
                type: isFolder ? 'folder' : (['.mp4', '.webm'].includes(ext) ? 'video' : 'image'),
                mtime: stats.mtime,
                isFolder
            };
        }).filter(f => f.isFolder || ['.png', '.jpg', '.jpeg', '.mp4', '.webm', '.gif'].includes(path.extname(f.name).toLowerCase()))
          .sort((a, b) => {
              if (a.isFolder && !b.isFolder) return -1;
              if (!a.isFolder && b.isFolder) return 1;
              return b.mtime - a.mtime;
          });
        res.json({ files });
    } catch (e) { res.status(400).json({ error: e.message }); }
});
publicApp.get('/api/health', async (req, res) => { const inst = await Promise.all(COMFYUI_URLS.map(async u => { try { return { url: u, status: (await fetch(`${u}/system_stats`, { timeout: 2000 })).ok ? 'connected' : 'disconnected' }; } catch(e){ return { url: u, status: 'disconnected' }; } })); res.json({ status: inst.some(i => i.status === 'connected') ? 'ok' : 'error', comfyui: inst.some(i => i.status === 'connected') ? 'connected' : 'disconnected', instances: inst }); });

// Error handlers
adminApp.use((err, req, res, next) => {
    console.error('[Admin] Uncaught error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Internal Server Error' });
});
publicApp.use((err, req, res, next) => {
    console.error('[Public] Uncaught error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Internal Server Error' });
});

// ============ START ============

async function startServers() {
    ADMIN_PORT = await findFreePort(ADMIN_PORT); PUBLIC_PORT = await findFreePort(Math.max(PUBLIC_PORT, ADMIN_PORT + 1));
    const adminServer = adminApp.listen(ADMIN_PORT, '0.0.0.0', () => console.log(`🔧 ADMIN http://localhost:${ADMIN_PORT}`));
    const publicServer = publicApp.listen(PUBLIC_PORT, '0.0.0.0', () => console.log(`🌐 PUBLIC http://localhost:${PUBLIC_PORT}`));
    const setupWsProxy = (server) => {
        const wss = new WebSocket.Server({ noServer: true });
        server.on('upgrade', async (req, socket, head) => {
            if (req.url.startsWith('/ws')) {
                const targetInstance = await getFreestInstance();
                const remoteWs = new WebSocket(targetInstance.replace(/^http/, 'ws') + '/ws');
                wss.handleUpgrade(req, socket, head, (ws) => {
                    remoteWs.on('open', () => { ws.on('message', m => remoteWs.send(m)); remoteWs.on('message', m => ws.send(m)); });
                    remoteWs.on('close', () => ws.close()); ws.on('close', () => remoteWs.close());
                    remoteWs.on('error', () => ws.close()); ws.on('error', () => remoteWs.close());
                });
            }
        });
    };
    setupWsProxy(adminServer); setupWsProxy(publicServer);
}
startServers();
