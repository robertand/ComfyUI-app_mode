let currentWorkflow = null;
let currentWorkflowId = null;
let uiConfig = { visibleInputs: {}, visibleParams: {}, inputOrder: [], inputNames: {} };
let mediaFiles = {};
let parameters = {};
let bypassedNodes = {};
let originalValues = {};
let currentPresets = [];

function initIcons() { if (window.lucide) window.lucide.createIcons(); }

async function loadWorkflows() {
    try {
        const res = await fetch('/api/workflows/list');
        const data = await res.json();
        const list = document.getElementById('workflows-list');
        list.innerHTML = '';
        if (data.workflows.length === 0) {
            list.innerHTML = '<div class="text-center py-4 text-slate-600 italic text-xs" data-i18n="no_workflows">No workflows found</div>';
            translatePage(localStorage.getItem('preferredLanguage') || 'en');
            return;
        }
        data.workflows.forEach(w => {
            const div = document.createElement('div');
            div.className = 'group flex items-center justify-between p-2 rounded-md hover:bg-slate-800 transition-all cursor-pointer';
            div.innerHTML = `<div class="flex-1 min-w-0" onclick="loadWorkflow('${w.id}')"><div class="text-xs font-bold text-slate-300 truncate">${w.name}</div><div class="text-[10px] text-slate-500 truncate">${w.description || ''}</div></div><button onclick="deleteWorkflow('${w.id}')" class="opacity-0 group-hover:opacity-100 p-1 hover:text-red-400 transition-all"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>`;
            list.appendChild(div);
        });
        initIcons(); translatePage(localStorage.getItem('preferredLanguage') || 'en');
    } catch (e) { console.error(e); }
}

async function loadWorkflow(id) {
    try {
        const res = await fetch(`/api/workflows/load/${id}`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            currentWorkflowId = id;
            setupWorkflow(data);
        }
        else alert('Error: ' + data.error);
    } catch (e) { console.error(e); }
}

function setupWorkflow(data) {
    currentWorkflow = data.analysis;
    uiConfig = data.uiConfig;
    originalValues = data.originalValues || {};
    mediaFiles = {}; parameters = {}; bypassedNodes = {};
    currentPresets = data.metadata?.presets || [];

    document.getElementById('empty-state').classList.add('hidden');
    document.getElementById('workflow-config').classList.remove('hidden');
    document.getElementById('workflow-header').classList.remove('hidden');
    document.getElementById('current-workflow-title').textContent = data.metadata?.name || currentWorkflow.title;
    document.getElementById('current-workflow-desc').textContent = data.metadata?.description || '';
    refreshUI();
}

function refreshUI() {
    renderMediaConfig(); renderParametersConfig(); renderLiveUI(); renderPresets(currentPresets);
    translatePage(localStorage.getItem('preferredLanguage') || 'en');
}

function moveNode(key, direction) {
    const idx = uiConfig.inputOrder.indexOf(key);
    if (idx === -1) return;
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= uiConfig.inputOrder.length) return;
    const temp = uiConfig.inputOrder[idx];
    uiConfig.inputOrder[idx] = uiConfig.inputOrder[newIdx];
    uiConfig.inputOrder[newIdx] = temp;
    refreshUI();
}

function renderParametersConfig() {
    const container = document.getElementById('parameters-container');
    container.innerHTML = '';
    const allParams = [];
    currentWorkflow.advancedInputs.forEach(g => allParams.push(...g.inputs));
    const sorted = allParams.filter(p => uiConfig.inputOrder.includes(p.key)).sort((a,b) => uiConfig.inputOrder.indexOf(a.key) - uiConfig.inputOrder.indexOf(b.key));

    sorted.forEach(param => {
        const isVisible = uiConfig.visibleParams[param.key] !== false;
        const isBypassed = bypassedNodes[param.nodeId];
        const originalTitle = param.nodeTitle || param.title;
        const nodeType = param.nodeType || '';
        const techInfo = originalTitle === nodeType ? originalTitle : `${originalTitle} - ${nodeType}`;
        const div = document.createElement('div');
        div.className = 'flex flex-col gap-1.5 p-2 bg-slate-800/30 rounded border border-slate-700/50';
        div.innerHTML = `<div class="flex items-center justify-between"><div class="flex items-center gap-2 min-w-0"><input type="checkbox" class="param-visibility-check w-3.5 h-3.5 rounded bg-slate-800 border-slate-700 text-blue-600" data-key="${param.key}" data-type="param" ${isVisible ? 'checked' : ''} onchange="uiConfig.visibleParams['${param.key}'] = this.checked; renderLiveUI();"><span class="text-[10px] font-bold text-slate-400 truncate">${param.title} <span class="text-slate-600 font-normal">(${techInfo})</span></span></div><div class="flex items-center gap-1 shrink-0"><button onclick="moveNode('${param.key}', -1)" class="p-0.5 hover:bg-slate-700 rounded"><i data-lucide="chevron-up" class="w-3 h-3"></i></button><button onclick="moveNode('${param.key}', 1)" class="p-0.5 hover:bg-slate-700 rounded"><i data-lucide="chevron-down" class="w-3 h-3"></i></button><button onclick="toggleBypass('${param.nodeId}', 'params')" class="text-[8px] font-bold px-1 py-0.5 rounded border border-slate-700 ${isBypassed ? 'bg-red-900/50 text-red-400 border-red-500/50' : 'text-slate-500'}">BYPASS</button></div></div><input type="text" value="${uiConfig.inputNames?.[param.key] || param.title}" class="w-full bg-slate-900/50 border border-slate-700 rounded px-2 py-1 text-[10px] outline-none" onchange="uiConfig.inputNames['${param.key}'] = this.value; renderLiveUI();">`;
        container.appendChild(div);
    });
    initIcons();
}

function renderMediaConfig() {
    const container = document.getElementById('media-config-container');
    container.innerHTML = '';
    const allMedia = [];
    currentWorkflow.inputs.forEach(g => allMedia.push(...g.inputs));
    const sorted = allMedia.filter(m => uiConfig.inputOrder.includes(m.key)).sort((a,b) => uiConfig.inputOrder.indexOf(a.key) - uiConfig.inputOrder.indexOf(b.key));

    sorted.forEach(input => {
        const isVisible = uiConfig.visibleInputs[input.key] !== false;
        const isBypassed = bypassedNodes[input.nodeId];
        const originalTitle = input.nodeTitle || input.title || 'Media';
        const nodeType = input.nodeType || '';
        const techInfo = originalTitle === nodeType ? originalTitle : `${originalTitle} - ${nodeType}`;
        const div = document.createElement('div');
        div.className = 'flex flex-col gap-1.5 p-2 bg-slate-800/30 rounded border border-slate-700/50';
        div.innerHTML = `<div class="flex items-center justify-between"><div class="flex items-center gap-2 min-w-0"><input type="checkbox" class="param-visibility-check w-3.5 h-3.5 rounded bg-slate-800 border-slate-700 text-blue-600" data-key="${input.key}" data-type="media" ${isVisible ? 'checked' : ''} onchange="uiConfig.visibleInputs['${input.key}'] = this.checked; renderLiveUI();"><span class="text-[10px] font-bold text-slate-400 truncate">${input.title} <span class="text-slate-600 font-normal">(${techInfo})</span></span></div><div class="flex items-center gap-1 shrink-0"><button onclick="moveNode('${input.key}', -1)" class="p-0.5 hover:bg-slate-700 rounded"><i data-lucide="chevron-up" class="w-3 h-3"></i></button><button onclick="moveNode('${input.key}', 1)" class="p-0.5 hover:bg-slate-700 rounded"><i data-lucide="chevron-down" class="w-3 h-3"></i></button><button onclick="toggleBypass('${input.nodeId}', 'media')" class="text-[8px] font-bold px-1 py-0.5 rounded border border-slate-700 ${isBypassed ? 'bg-red-900/50 text-red-400 border-red-500/50' : 'text-slate-500'}">BYPASS</button></div></div><input type="text" value="${uiConfig.inputNames?.[input.key] || input.title}" class="w-full bg-slate-900/50 border border-slate-700 rounded px-2 py-1 text-[10px] outline-none" onchange="uiConfig.inputNames['${input.key}'] = this.value; renderLiveUI();">`;
        container.appendChild(div);
    });
    initIcons();
}

function renderLiveUI() {
    const container = document.getElementById('active-inputs-container');
    container.innerHTML = '';
    if (!uiConfig.inputOrder) return;

    uiConfig.inputOrder.forEach(key => {
        let obj = null;
        currentWorkflow.inputs.forEach(g => { const f = g.inputs.find(i => i.key === key); if (f) obj = { type: 'media', data: f }; });
        if (!obj) { currentWorkflow.advancedInputs.forEach(g => { const f = g.inputs.find(p => p.key === key); if (f) obj = { type: 'param', data: f }; }); }
        if (!obj) return;

        const isVisible = (obj.type === 'media' ? uiConfig.visibleInputs[key] : uiConfig.visibleParams[key]) !== false;
        if (!isVisible) return;

        const isBypassed = bypassedNodes[obj.data.nodeId];
        const label = uiConfig.inputNames?.[key] || obj.data.title;
        const div = document.createElement('div');
        div.className = 'slate-card p-6 rounded-xl space-y-4 shadow-lg';

        if (obj.type === 'media') {
            div.innerHTML = `<div class="flex items-center justify-between mb-2"><label class="block text-sm font-bold text-slate-300 uppercase tracking-wider">${label}</label><button onclick="toggleBypass('${obj.data.nodeId}', 'media')" class="text-[10px] font-bold px-2 py-0.5 rounded border border-slate-700 ${isBypassed ? 'bg-red-900/50 text-red-400 border-red-500/50' : 'text-slate-500'}">BYPASS</button></div><div class="relative group aspect-video bg-slate-900 rounded-lg border-2 border-dashed border-slate-700 hover:border-blue-500 transition-all overflow-hidden flex items-center justify-center cursor-pointer ${isBypassed ? 'opacity-30 pointer-events-none' : ''}"><input type="file" class="absolute inset-0 opacity-0 cursor-pointer z-10" onchange="handleMediaUpload(this.files[0], '${key}')"><div id="preview-${key}" class="text-center p-4"><i data-lucide="${obj.data.valueType === 'video' ? 'video' : 'image'}" class="w-10 h-10 mb-2 mx-auto text-slate-600"></i><p class="text-xs text-slate-500" data-i18n="click_or_drag">Click or drag</p></div></div>`;
        } else {
            const cur = parameters[key] !== undefined ? parameters[key] : obj.data.defaultValue;
            const isRandom = parameters['_autoRandomSeed']?.[key] === true;
            let inputHtml = '';
            if (obj.data.valueType === 'boolean') {
                inputHtml = `<select class="w-full bg-slate-800 border border-slate-700 rounded-md px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none ${isBypassed ? 'opacity-30 pointer-events-none' : ''}" onchange="parameters['${key}'] = this.value">
                    <option value="true" ${cur === 'true' || cur === true ? 'selected' : ''}>Yes</option>
                    <option value="false" ${cur === 'false' || cur === false ? 'selected' : ''}>No</option>
                </select>`;
            } else {
                inputHtml = `
                    <div class="relative">
                        <input type="${obj.data.valueType === 'number' ? 'number' : 'text'}" value="${cur || ''}"
                            class="w-full bg-slate-800 border border-slate-700 rounded-md px-4 py-2.5 pr-12 text-sm focus:ring-2 focus:ring-blue-500 outline-none ${isBypassed ? 'opacity-30 pointer-events-none' : ''} ${isRandom ? 'text-slate-500 italic' : ''}"
                            ${isRandom ? 'disabled' : ''}
                            onchange="parameters['${key}'] = this.value">
                        ${obj.data.valueType === 'number' && (
                            (obj.data.inputName || '').toLowerCase().includes('seed') ||
                            (obj.data.originalName || '').toLowerCase().includes('seed') ||
                            (label || '').toLowerCase().includes('seed') ||
                            (key || '').toLowerCase().includes('seed')
                        ) ? `
                        <button onclick="toggleRandom('${key}')" class="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded hover:bg-slate-700 transition-colors ${isRandom ? 'text-blue-400 bg-blue-500/10' : 'text-slate-500'}" title="${getTranslation('toggle_randomization')}">
                            <i data-lucide="dice-5" class="w-4 h-4"></i>
                        </button>` : ''}
                    </div>`;
            }
            div.innerHTML = `<div class="flex items-center justify-between mb-2"><label class="block text-xs font-semibold text-slate-500 uppercase tracking-widest">${label}</label><button onclick="toggleBypass('${obj.data.nodeId}', 'params')" class="text-[10px] font-bold px-2 py-0.5 rounded border border-slate-700 ${isBypassed ? 'bg-red-900/50 text-red-400 border-red-500/50' : 'text-slate-500'}">BYPASS</button></div>${inputHtml}`;
        }
        container.appendChild(div);
    });
    initIcons();
}

async function handleMediaUpload(file, key) {
    if (!file) return;
    const p = document.getElementById(`preview-${key}`);
    p.innerHTML = '<div class="loader ease-linear rounded-full border-2 border-t-2 border-blue-500 h-6 w-6 mx-auto"></div>';
    const fd = new FormData(); fd.append('media', file);
    try {
        const res = await fetch(`/api/upload/media/${key}`, { method: 'POST', body: fd });
        const data = await res.json();
        mediaFiles[key] = data.filename;
        p.innerHTML = data.type === 'video' ? `<video src="/output/${data.filename}" class="w-full h-full object-cover"></video>` : `<img src="/output/${data.filename}" class="w-full h-full object-cover">`;
    } catch (e) { p.innerHTML = '<i data-lucide="alert-circle" class="w-8 h-8 text-red-500 mx-auto"></i>'; initIcons(); }
}

function toggleBypass(id, src) {
    bypassedNodes[id] = !bypassedNodes[id];
    if (src === 'media') renderMediaConfig(); else renderParametersConfig();
    renderLiveUI();
}

function toggleRandom(key) {
    if (!parameters['_autoRandomSeed']) parameters['_autoRandomSeed'] = {};
    parameters['_autoRandomSeed'][key] = !parameters['_autoRandomSeed'][key];
    renderLiveUI();
}

async function runWorkflow() {
    const btn = document.getElementById('generate-btn'); const ov = document.getElementById('loading-overlay');
    btn.disabled = true; ov.classList.remove('hidden');
    try {
        const res = await fetch('/api/workflow/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaFiles, parameters, bypassedNodes }) });
        const data = await res.json();
        if (data.success && data.files.length > 0) {
            const f = data.files[0]; const c = document.getElementById('output-media-container'); const ph = document.getElementById('output-placeholder');
            ph.classList.add('hidden'); c.classList.remove('hidden'); c.innerHTML = f.type === 'video' ? `<video src="${f.url}" controls autoplay class="max-w-full max-h-full rounded"></video>` : `<img src="${f.url}" class="max-w-full max-h-full object-contain cursor-pointer rounded" onclick="showModal('${f.url}', 'image')">`;
            refreshOutputs();
        } else if (data.error) alert('Error: ' + data.error);
    } catch (e) { alert('Connection error'); } finally { btn.disabled = false; ov.classList.add('hidden'); }
}

async function saveUIConfig() {
    try {
        const res = await fetch('/api/config/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: uiConfig }) });
        const data = await res.json();
        if (data.success) alert('Configuration saved!');
    } catch (e) { console.error(e); }
}

async function saveWorkflow() {
    const name = document.getElementById('save-name').value;
    const desc = document.getElementById('save-description').value;
    if (!name) return alert('Name is required');
    try {
        const res = await fetch('/api/workflows/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description: desc, presets: currentPresets }) });
        const data = await res.json();
        if (data.success) { loadWorkflows(); alert(getTranslation('saved_msg')); }
    } catch (e) { console.error(e); }
}

function renderPresets(presets) {
    currentPresets = presets || [];
    const container = document.getElementById('presets-container');
    container.innerHTML = '';
    if (currentPresets.length === 0) {
        container.innerHTML = '<div class="col-span-full text-center py-4 text-slate-600 text-[10px] italic" data-i18n="no_presets_msg">No presets</div>';
        translatePage(localStorage.getItem('preferredLanguage') || 'en');
        return;
    }
    currentPresets.forEach((p, idx) => {
        const div = document.createElement('div');
        div.className = 'relative group aspect-square rounded bg-slate-800 overflow-hidden border border-slate-700 hover:border-blue-500 transition-all cursor-pointer';
        div.innerHTML = `<img src="${p.url}" class="w-full h-full object-cover"><div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-all"><button onclick="event.stopPropagation(); deletePreset(${idx})" class="p-1 bg-red-600 rounded-full text-white"><i data-lucide="trash-2" class="w-2.5 h-2.5"></i></button></div>`;
        div.onclick = () => { if (p.mediaFiles) mediaFiles = { ...mediaFiles, ...p.mediaFiles }; if (p.parameters) parameters = { ...parameters, ...p.parameters }; if (p.bypassedNodes) bypassedNodes = { ...bypassedNodes, ...p.bypassedNodes }; refreshUI(); };
        container.appendChild(div);
    });
    initIcons();
}

async function addPreset() {
    if (!currentWorkflow) return alert(getTranslation('add_preset_hint'));
    const c = document.getElementById('output-media-container'); const img = c.querySelector('img');
    if (!img) return alert('Generate an image first');
    currentPresets.push({ url: img.src, mediaFiles: { ...mediaFiles }, parameters: { ...parameters }, bypassedNodes: { ...bypassedNodes } });
    renderPresets(currentPresets);
}

function deletePreset(idx) { if (confirm(getTranslation('confirm_delete_preset'))) { currentPresets.splice(idx, 1); renderPresets(currentPresets); } }

async function deleteWorkflow(id) {
    if (!confirm(getTranslation('confirm_delete_workflow'))) return;
    try { await fetch(`/api/workflows/delete/${id}`, { method: 'DELETE' }); loadWorkflows(); } catch (e) { console.error(e); }
}

async function refreshOutputs() {
    try {
        const res = await fetch('/api/outputs');
        const data = await res.json();
        const gallery = document.getElementById('outputs-gallery');
        gallery.innerHTML = '';
        if (data.files.length === 0) { gallery.innerHTML = '<div class="col-span-full text-center py-12 text-slate-600 italic" data-i18n="no_outputs">No items found</div>'; translatePage(localStorage.getItem('preferredLanguage') || 'en'); return; }
        data.files.forEach(f => {
            const card = document.createElement('div'); card.className = 'slate-card rounded-lg overflow-hidden group cursor-pointer relative aspect-square';
            card.innerHTML = `${f.type === 'video' ? `<video src="${f.url}" class="w-full h-full object-cover"></video><div class="absolute inset-0 flex items-center justify-center bg-black/20"><i data-lucide="play" class="text-white w-8 h-8"></i></div>` : `<img src="${f.url}" class="w-full h-full object-cover">`}<button onclick="event.stopPropagation(); deleteOutput('${f.name}')" class="absolute top-2 right-2 p-1.5 bg-red-600 rounded-full text-white opacity-0 group-hover:opacity-100 transition-all shadow-lg"><i data-lucide="trash-2" class="w-3 h-3"></i></button>`;
            card.onclick = () => showModal(f.url, f.type); gallery.appendChild(card);
        });
        initIcons();
    } catch (e) { console.error(e); }
}

async function deleteOutput(fn) { if (!confirm('Delete file?')) return; try { await fetch(`/api/outputs/${fn}`, { method: 'DELETE' }); refreshOutputs(); } catch (e) { console.error(e); } }

function showModal(url, type) {
    const m = document.getElementById('media-modal'); const c = document.getElementById('modal-content');
    c.innerHTML = type === 'video' ? `<video src="${url}" controls autoplay class="max-w-full max-h-full rounded-lg shadow-2xl"></video>` : `<img src="${url}" class="max-w-full max-h-full object-contain rounded-lg shadow-2xl">`;
    m.classList.remove('hidden');
}

function toggleCollapse(id) {
    const el = document.getElementById(id); const ch = document.getElementById(id.replace('container', 'chevron'));
    if (el.style.maxHeight === '0px' || el.style.display === 'none') { el.style.display = 'block'; el.style.maxHeight = '2000px'; if (ch) ch.style.transform = 'rotate(0deg)'; }
    else { el.style.maxHeight = '0px'; setTimeout(() => { if (el.style.maxHeight === '0px') el.style.display = 'none'; }, 300); if (ch) ch.style.transform = 'rotate(-90deg)'; }
}
window.toggleCollapse = toggleCollapse;

function initAdmin() {
    const uploadBtn = document.getElementById('upload-btn');
    if (uploadBtn) uploadBtn.onclick = () => document.getElementById('workflow-file').click();

    const workflowFile = document.getElementById('workflow-file');
    if (workflowFile) workflowFile.onchange = async (e) => {
        const f = e.target.files[0]; if (!f) return;
        const fd = new FormData(); fd.append('workflow', f);
        try { const res = await fetch('/api/workflow/upload', { method: 'POST', body: fd }); const data = await res.json(); setupWorkflow(data); } catch (e) { console.error(e); }
    };

    if (document.getElementById('save-workflow-btn')) document.getElementById('save-workflow-btn').onclick = saveWorkflow;
    if (document.getElementById('add-preset-btn')) document.getElementById('add-preset-btn').onclick = addPreset;
    if (document.getElementById('save-ui-config')) document.getElementById('save-ui-config').onclick = saveUIConfig;
    if (document.getElementById('generate-btn')) document.getElementById('generate-btn').onclick = runWorkflow;
    if (document.getElementById('refresh-outputs-btn')) document.getElementById('refresh-outputs-btn').onclick = refreshOutputs;
    if (document.getElementById('close-modal')) document.getElementById('close-modal').onclick = () => document.getElementById('media-modal').classList.add('hidden');

    const addUrlBtn = document.getElementById('add-url-btn');
    if (addUrlBtn) addUrlBtn.onclick = () => {
        const container = document.getElementById('comfy-urls-container');
        const div = document.createElement('div');
        div.className = 'flex items-center gap-2';
        div.innerHTML = `<input type="text" value="http://127.0.0.1:8188" class="comfy-url-input flex-1 bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-xs outline-none focus:ring-1 focus:ring-blue-500"><button onclick="this.parentElement.remove()" class="p-2 text-slate-500 hover:text-red-400"><i data-lucide="trash-2" class="w-4 h-4"></i></button>`;
        container.appendChild(div);
        initIcons();
    };

    const updateUrlBtn = document.getElementById('update-url-btn');
    if (updateUrlBtn) updateUrlBtn.onclick = async () => {
        const inputs = document.querySelectorAll('.comfy-url-input');
        const comfyuiUrls = Array.from(inputs).map(i => i.value).filter(v => v.trim() !== '');
        if (comfyuiUrls.length === 0) return alert(getTranslation('at_least_one_url'));

        try {
            const res = await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ comfyuiUrls })
            });
            const data = await res.json();
            if (data.success) alert(getTranslation('url_updated'));
            else alert('Error: ' + data.error);
        } catch (e) { alert('Error updating settings'); }
    };

    const selectAllBtn = document.getElementById('select-all-btn');
    if (selectAllBtn) selectAllBtn.onclick = () => {
        document.querySelectorAll('.param-visibility-check').forEach(c => {
            c.checked = true;
            const key = c.getAttribute('data-key');
            const type = c.getAttribute('data-type');
            if (type === 'media') uiConfig.visibleInputs[key] = true;
            else uiConfig.visibleParams[key] = true;
        });
        renderLiveUI();
    };

    const deselectAllBtn = document.getElementById('deselect-all-btn');
    if (deselectAllBtn) deselectAllBtn.onclick = () => {
        document.querySelectorAll('.param-visibility-check').forEach(c => {
            c.checked = false;
            const key = c.getAttribute('data-key');
            const type = c.getAttribute('data-type');
            if (type === 'media') uiConfig.visibleInputs[key] = false;
            else uiConfig.visibleParams[key] = false;
        });
        renderLiveUI();
    };

    loadWorkflows(); refreshOutputs();
}

function renderUrlSettings(urls) {
    const container = document.getElementById('comfy-urls-container');
    if (!container) return;
    container.innerHTML = '';
    const urlList = (urls && urls.length > 0) ? urls : ['http://127.0.0.1:8188'];
    urlList.forEach((url) => {
        const div = document.createElement('div');
        div.className = 'flex items-center gap-2';
        div.innerHTML = `<input type="text" value="${url}" class="comfy-url-input flex-1 bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-xs outline-none focus:ring-1 focus:ring-blue-500"><button onclick="this.parentElement.remove()" class="p-2 text-slate-500 hover:text-red-400"><i data-lucide="trash-2" class="w-4 h-4"></i></button>`;
        container.appendChild(div);
    });
    initIcons();
}
window.renderUrlSettings = renderUrlSettings;

document.addEventListener('DOMContentLoaded', initAdmin);

setInterval(async () => {
    try {
        const res = await fetch('/api/health'); const data = await res.json();
        const badge = document.getElementById('status-badge');
        if (data.comfyui === 'connected') { badge.className = 'flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-900/30 border border-emerald-500/50 text-emerald-400 text-sm font-medium'; badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-500"></span><span data-i18n="connected">Connected</span>'; }
        else { badge.className = 'flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-900/30 border border-red-500/50 text-red-400 text-sm font-medium'; badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span><span data-i18n="disconnected">Disconnected</span>'; }
        translatePage(localStorage.getItem('preferredLanguage') || 'en');
    } catch (e) {}
}, 5000);
