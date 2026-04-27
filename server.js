const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const FormData = require('form-data');
const net = require('net');

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

const upload = multer({ dest: 'uploads/', limits: { fileSize: 1024 * 1024 * 1024 } });

['uploads', 'output', 'workflows', 'workflows/saved'].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

let currentWorkflowData = null;
let currentWorkflowId = null;
let uiConfig = null;
let originalWorkflowValues = {};
const mediaStore = {};

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
    app.use(express.json({ limit: '100mb' }));
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

adminApp.use(express.static('public')); adminApp.use('/output', express.static('output'));
publicApp.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'public.html')));
publicApp.use(express.static('public')); publicApp.use('/output', express.static('output'));

function reconcileUIConfig(analysis, existingConfig) {
    const config = { visibleInputs: existingConfig?.visibleInputs || {}, visibleParams: existingConfig?.visibleParams || {}, inputOrder: existingConfig?.inputOrder || [], inputNames: existingConfig?.inputNames || {} };
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
    fs.writeFileSync(filePath, JSON.stringify({ metadata: { id, name, description: req.body.description || '', createdAt: new Date().toISOString(), presets: req.body.presets || [] }, workflow: currentWorkflowData.raw, analysis: currentWorkflowData.analysis, uiConfig }, null, 2));
    currentWorkflowId = id; res.json({ success: true, id, name });
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

adminApp.post('/api/upload/media/:inputKey', upload.single('media'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const fn = `${generateId()}${path.extname(req.file.originalname)}`, p = path.join('output', fn); fs.renameSync(req.file.path, p);
    mediaStore[fn] = { path: p, originalName: req.file.originalname, mimetype: req.file.mimetype };
    res.json({ success: true, filename: fn, type: req.file.mimetype.startsWith('video/') ? 'video' : 'image' });
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
        for (const [k, fn] of Object.entries(mediaFiles || {})) {
            let finalFn = fn; if (mediaStore[fn]) finalFn = (await uploadFileToInstance(target, mediaStore[fn].path, mediaStore[fn].originalName, mediaStore[fn].mimetype)).name;
            analysis.inputs?.forEach(g => g.inputs?.forEach(i => { if (i.key === k && workflow[i.nodeId]) workflow[i.nodeId].inputs[i.inputName] = finalFn; }));
        }

        // SYNC: Ensure we use the latest memory if this is the active admin session
        const baseParams = (!isPublic && currentWorkflowId) ? originalWorkflowValues : extractOriginalWorkflowValues(workflow);
        const finalParams = { ...baseParams, ...parameters };

        const auto = parameters?.['_autoRandomSeed'] || {};
        for (const [pk, v] of Object.entries(finalParams)) {
            if (shouldGenerateRandomSeed(pk, v, auto)) finalParams[pk] = generateRandomSeed();
            analysis.advancedInputs.forEach(g => g.inputs?.forEach(p => {
                if (p.key === pk && workflow[p.nodeId]) {
                    let fv = finalParams[pk];
                    if (p.valueType === 'number') fv = parseFloat(fv); else if (p.valueType === 'boolean') fv = (fv === 'true' || fv === true);
                    else if (p.valueType === 'pixaroma_editor' && typeof fv === 'string') { try { fv = JSON.parse(fv); } catch(e){} }
                    workflow[p.nodeId].inputs[p.inputName] = fv;
                    console.log(`[Run] Applying ${pk} to Node ${p.nodeId} (${p.inputName}):`, typeof fv === 'object' ? 'JSON object' : fv);
                }
            }));
        }

        const { workflow: vw, warnings } = validateWorkflowParameters(workflow);
        console.log('[Run] Submitting prompt to ComfyUI...');
        const qRes = await fetch(`${target}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: vw }) });
        const qData = await qRes.json(); if (qData.error) throw new Error(qData.error.message || JSON.stringify(qData.error));

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
        res.json({ success: true, files: outputFiles, warnings: warnings.length > 0 ? warnings : undefined });
    } catch (e) { res.status(500).json({ error: e.message }); }
}

adminApp.post('/api/workflows/save-parameters', (req, res) => {
    try {
        const { workflowId, parameters } = req.body;
        if (!workflowId) return res.status(400).json({ error: 'Workflow ID missing' });
        const savedDir = path.join('workflows', 'saved');
        const file = fs.readdirSync(savedDir).find(f => f.includes(workflowId));
        if (!file) return res.status(404).json({ error: 'Workflow not found' });
        const filePath = path.join(savedDir, file), data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
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

                        // SYNC: Update in-memory data if this is the active workflow
                        if (currentWorkflowId && workflowId.includes(currentWorkflowId)) {
                            originalWorkflowValues[key] = value;
                            if (currentWorkflowData?.workflowApi?.[nodeId]) {
                                currentWorkflowData.workflowApi[nodeId].inputs[inputName] = finalValue;
                            }
                        }
                    }
                }
            });
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
            console.log(`[SaveParam] Persisted and synced parameters for ${workflowId}`);
            return res.json({ success: true });
        }
        res.status(400).json({ error: 'Analysis missing' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

adminApp.post('/api/workflow/run', (req, res) => runWorkflowLogic(req, res));
publicApp.post('/api/workflow/run', (req, res) => runWorkflowLogic(req, res, true));

adminApp.get('/api/config', (req, res) => res.json({ adminPort: ADMIN_PORT, publicPort: PUBLIC_PORT, comfyuiUrls: COMFYUI_URLS }));
adminApp.post('/api/settings', (req, res) => { COMFYUI_URLS = req.body.comfyuiUrls; CONFIG.COMFYUI_URLS = COMFYUI_URLS; fs.writeFileSync(CONFIG_FILE, JSON.stringify(CONFIG, null, 2)); res.json({ success: true }); });
adminApp.delete('/api/outputs/:filename', (req, res) => { const p = path.join('output', req.params.filename); if (fs.existsSync(p)) fs.unlinkSync(p); res.json({ success: true }); });
adminApp.get('/api/outputs', (req, res) => res.json({ files: fs.readdirSync('output').filter(f => ['.png', '.jpg', '.jpeg', '.mp4', '.webm', '.gif'].includes(path.extname(f).toLowerCase())).map(f => ({ name: f, url: `/output/${f}`, type: ['.mp4', '.webm'].includes(path.extname(f).toLowerCase()) ? 'video' : 'image', mtime: fs.statSync(path.join('output', f)).mtime })).sort((a,b) => b.mtime - a.mtime) }));
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
    const fn = `${generateId()}${path.extname(req.file.originalname)}`, p = path.join('output', fn); fs.renameSync(req.file.path, p);
    mediaStore[fn] = { path: p, originalName: req.file.originalname, mimetype: req.file.mimetype };
    res.json({ success: true, filename: fn, type: req.file.mimetype.startsWith('video/') ? 'video' : 'image' });
});
publicApp.get('/api/config', (req, res) => res.json({ adminPort: ADMIN_PORT, publicPort: PUBLIC_PORT, comfyuiUrls: COMFYUI_URLS }));
publicApp.get('/api/outputs', (req, res) => res.json({ files: fs.readdirSync('output').filter(f => ['.png', '.jpg', '.jpeg', '.mp4', '.webm', '.gif'].includes(path.extname(f).toLowerCase())).map(f => ({ name: f, url: `/output/${f}`, type: ['.mp4', '.webm'].includes(path.extname(f).toLowerCase()) ? 'video' : 'image', mtime: fs.statSync(path.join('output', f)).mtime })).sort((a,b) => b.mtime - a.mtime) }));
publicApp.get('/api/health', async (req, res) => { const inst = await Promise.all(COMFYUI_URLS.map(async u => { try { return { url: u, status: (await fetch(`${u}/system_stats`, { timeout: 2000 })).ok ? 'connected' : 'disconnected' }; } catch(e){ return { url: u, status: 'disconnected' }; } })); res.json({ status: inst.some(i => i.status === 'connected') ? 'ok' : 'error', comfyui: inst.some(i => i.status === 'connected') ? 'connected' : 'disconnected', instances: inst }); });

// ============ START ============

async function startServers() {
    ADMIN_PORT = await findFreePort(ADMIN_PORT); PUBLIC_PORT = await findFreePort(Math.max(PUBLIC_PORT, ADMIN_PORT + 1));
    const adminServer = adminApp.listen(ADMIN_PORT, '0.0.0.0', () => console.log(`🔧 ADMIN http://localhost:${ADMIN_PORT}`));
    const publicServer = publicApp.listen(PUBLIC_PORT, '0.0.0.0', () => console.log(`🌐 PUBLIC http://localhost:${PUBLIC_PORT}`));
    const setupWsProxy = (server) => {
        const wss = new WebSocket.Server({ noServer: true });
        server.on('upgrade', async (req, socket, head) => {
            if (req.url === '/ws') {
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
