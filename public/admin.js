let currentWorkflow = null;
let uiConfig = { visibleInputs: {}, visibleParams: {}, inputOrder: [], inputNames: {} };
let mediaFiles = {};
let parameters = {};
let bypassedNodes = {};
let originalValues = {};

async function loadWorkflows() {
    try {
        const res = await fetch('/api/workflows/list');
        const data = await res.json();
        const list = document.getElementById('workflows-list');
        list.innerHTML = '';

        if (data.workflows.length === 0) {
            list.innerHTML = '<div class="text-center py-8 text-slate-600 italic text-sm" data-i18n="no_workflows">No workflows found</div>';
            translatePage(localStorage.getItem('preferredLanguage') || 'en');
            return;
        }

        data.workflows.forEach(w => {
            const div = document.createElement('div');
            div.className = 'group flex items-center justify-between p-2 rounded-md hover:bg-slate-800 transition-all cursor-pointer';
            div.innerHTML = `
                <div class="flex-1 min-w-0" onclick="loadWorkflow('${w.id}')">
                    <div class="text-sm font-medium text-slate-200 truncate">${w.name}</div>
                    <div class="text-xs text-slate-500 truncate">${w.description || ''}</div>
                </div>
                <button onclick="deleteWorkflow('${w.id}')" class="opacity-0 group-hover:opacity-100 p-1 hover:text-red-400 transition-all">
                    <i data-lucide="trash-2" class="w-4 h-4"></i>
                </button>
            `;
            list.appendChild(div);
        });
        lucide.createIcons();
        translatePage(localStorage.getItem('preferredLanguage') || 'en');
    } catch (e) { console.error(e); }
}

async function loadWorkflow(id) {
    try {
        const res = await fetch(`/api/workflows/load/${id}`, { method: 'POST' });
        const data = await res.json();
        setupWorkflow(data);
    } catch (e) { console.error(e); }
}

function setupWorkflow(data) {
    currentWorkflow = data.analysis;
    uiConfig = data.uiConfig || { visibleInputs: {}, visibleParams: {}, inputOrder: [], inputNames: {} };
    originalValues = data.originalValues || {};
    mediaFiles = {};
    parameters = {};
    bypassedNodes = {};

    document.getElementById('empty-state').classList.add('hidden');
    document.getElementById('workflow-config').classList.remove('hidden');
    document.getElementById('workflow-header').classList.remove('hidden');

    document.getElementById('current-workflow-title').textContent = data.metadata?.name || currentWorkflow.title;
    document.getElementById('current-workflow-desc').textContent = data.metadata?.description || '';

    renderParameters();
    renderMediaInputs();
    renderPresets(data.metadata?.presets || []);
    translatePage(localStorage.getItem('preferredLanguage') || 'en');
}

function renderParameters() {
    const container = document.getElementById('parameters-container');
    container.innerHTML = '';

    currentWorkflow.advancedInputs.forEach(group => {
        const groupDiv = document.createElement('div');
        groupDiv.className = 'space-y-4 pb-4 border-b border-slate-800 last:border-0';
        groupDiv.innerHTML = `<h4 class="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">${group.title}</h4>`;

        const grid = document.createElement('div');
        grid.className = 'grid grid-cols-1 gap-2';

        group.inputs.forEach(param => {
            const isVisible = uiConfig.visibleParams[param.key] !== false;
            const isBypassed = bypassedNodes[param.nodeId];
            const div = document.createElement('div');
            div.className = 'flex flex-col gap-2 p-3 bg-slate-800/40 rounded-lg border border-slate-700/50 hover:border-blue-500/30 transition-all';

            div.innerHTML = `
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-2">
                        <input type="checkbox" class="param-visibility-check w-3.5 h-3.5 rounded border-slate-700 bg-slate-800 text-blue-600"
                               data-key="${param.key}" ${isVisible ? 'checked' : ''} onchange="uiConfig.visibleParams['${param.key}'] = this.checked">
                        <span class="text-[10px] font-bold text-slate-400 truncate max-w-[150px]">${param.title}</span>
                    </div>
                    <button onclick="toggleBypass('${param.nodeId}')" class="text-[9px] font-bold px-1.5 py-0.5 rounded border border-slate-700 hover:bg-slate-800 transition-all ${isBypassed ? 'bg-red-900/50 text-red-400 border-red-500/50' : 'text-slate-500'}" data-i18n="bypass">Bypass</button>
                </div>

                <input type="text" value="${uiConfig.inputNames?.[param.key] || param.title}"
                       class="w-full bg-slate-900/50 border border-slate-700 rounded px-2 py-1 text-[11px] outline-none focus:ring-1 focus:ring-blue-500 transition-all"
                       onchange="uiConfig.inputNames['${param.key}'] = this.value" placeholder="Custom Label">

                <div>
                    ${param.valueType === 'boolean' ? `
                        <select class="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-[11px] outline-none" onchange="parameters['${param.key}'] = this.value">
                            <option value="true" ${param.defaultValue === true ? 'selected' : ''}>True</option>
                            <option value="false" ${param.defaultValue === false ? 'selected' : ''}>False</option>
                        </select>
                    ` : `
                        <input type="${param.valueType === 'number' ? 'number' : 'text'}"
                               value="${param.defaultValue || ''}"
                               class="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-[11px] outline-none"
                               onchange="parameters['${param.key}'] = this.value">
                    `}
                </div>
            `;
            grid.appendChild(div);
        });
        groupDiv.appendChild(grid);
        container.appendChild(groupDiv);
    });
    lucide.createIcons();
}

function renderMediaInputs() {
    const container = document.getElementById('media-containers');
    container.innerHTML = '';

    currentWorkflow.inputs.forEach(group => {
        group.inputs.forEach(input => {
            const isVisible = uiConfig.visibleInputs[input.key] !== false;
            const isBypassed = bypassedNodes[input.nodeId];
            const div = document.createElement('div');
            div.className = 'space-y-3 p-4 rounded-xl bg-slate-900/30 border border-slate-800/50';

            div.innerHTML = `
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-2">
                        <input type="checkbox" class="w-4 h-4 rounded border-slate-700 bg-slate-800 text-blue-600"
                               ${isVisible ? 'checked' : ''} onchange="uiConfig.visibleInputs['${input.key}'] = this.checked">
                        <span class="text-sm font-bold text-slate-300">${uiConfig.inputNames?.[input.key] || input.title}</span>
                    </div>
                    <button onclick="toggleBypass('${input.nodeId}', 'media')" class="text-[10px] font-bold px-1.5 py-0.5 rounded border border-slate-700 hover:bg-slate-800 transition-all ${isBypassed ? 'bg-red-900/50 text-red-400 border-red-500/50' : 'text-slate-500'}" data-i18n="bypass">Bypass</button>
                </div>
                <div class="relative group aspect-video bg-slate-900 rounded-lg border-2 border-dashed border-slate-700 hover:border-blue-500 transition-all overflow-hidden flex items-center justify-center cursor-pointer ${isBypassed ? 'opacity-30 pointer-events-none' : ''}">
                    <input type="file" class="absolute inset-0 opacity-0 cursor-pointer z-10" onchange="handleMediaUpload(this.files[0], '${input.key}')">
                    <div id="preview-${input.key}" class="text-center p-4">
                        <i data-lucide="${input.valueType === 'video' ? 'video' : 'image'}" class="w-8 h-8 mb-2 mx-auto text-slate-600"></i>
                        <p class="text-xs text-slate-500" data-i18n="click_or_drag">Click or drag</p>
                    </div>
                </div>
            `;
            container.appendChild(div);
        });
    });
    lucide.createIcons();
}

async function handleMediaUpload(file, inputKey) {
    if (!file) return;
    const preview = document.getElementById(`preview-${inputKey}`);
    preview.innerHTML = '<div class="loader ease-linear rounded-full border-2 border-t-2 border-blue-500 h-6 w-6 mx-auto"></div>';

    const formData = new FormData();
    formData.append('media', file);

    try {
        const res = await fetch(`/api/upload/media/${inputKey}`, { method: 'POST', body: formData });
        const data = await res.json();
        mediaFiles[inputKey] = data.filename;

        if (data.type === 'video') {
            preview.innerHTML = `<video src="/output/${data.filename}" class="w-full h-full object-cover"></video>`;
        } else {
            preview.innerHTML = `<img src="/output/${data.filename}" class="w-full h-full object-cover">`;
        }
    } catch (e) { console.error(e); }
}

function toggleBypass(nodeId, source = 'params') {
    bypassedNodes[nodeId] = !bypassedNodes[nodeId];
    if (source === 'media') {
        renderMediaInputs();
    } else {
        renderParameters();
    }
}

async function runWorkflow() {
    const btn = document.getElementById('generate-btn');
    const overlay = document.getElementById('loading-overlay');
    btn.disabled = true;
    overlay.classList.remove('hidden');

    try {
        const res = await fetch('/api/workflow/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mediaFiles, parameters, bypassedNodes })
        });

        const data = await res.json();
        if (data.success && data.files.length > 0) {
            const file = data.files[0];
            const container = document.getElementById('output-media-container');
            const placeholder = document.getElementById('output-placeholder');

            placeholder.classList.add('hidden');
            container.classList.remove('hidden');
            container.innerHTML = '';

            if (file.type === 'video') {
                container.innerHTML = `<video src="${file.url}" controls autoplay class="max-w-full max-h-full"></video>`;
            } else {
                container.innerHTML = `<img src="${file.url}" class="max-w-full max-h-full object-contain cursor-pointer" onclick="showModal('${file.url}', 'image')">`;
            }
            refreshOutputs();
        } else if (data.error) {
            alert('Error: ' + data.error);
        }
    } catch (e) { alert('Connection error'); }
    finally {
        btn.disabled = false;
        overlay.classList.add('hidden');
    }
}

async function saveUIConfig() {
    try {
        await fetch('/api/config/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ config: uiConfig })
        });
        alert('Configuration saved!');
    } catch (e) { console.error(e); }
}

async function saveWorkflow() {
    const name = document.getElementById('save-name').value;
    const description = document.getElementById('save-description').value;
    if (!name) return alert('Name is required');

    try {
        const response = await fetch('/api/workflows/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                description,
                presets: currentPresets // Keep presets if they exist
            })
        });
        const data = await response.json();
        if (data.success) {
            loadWorkflows();
            alert(getTranslation('saved_msg'));
        }
    } catch (e) { console.error(e); }
}

let currentPresets = [];
function renderPresets(presets) {
    currentPresets = presets || [];
    const container = document.getElementById('presets-container');
    container.innerHTML = '';

    if (currentPresets.length === 0) {
        container.innerHTML = '<div class="col-span-full text-center py-4 text-slate-600 text-xs italic" data-i18n="no_presets_msg">No presets</div>';
        translatePage(localStorage.getItem('preferredLanguage') || 'en');
        return;
    }

    currentPresets.forEach((p, index) => {
        const div = document.createElement('div');
        div.className = 'relative group aspect-square rounded-lg overflow-hidden border border-slate-700 hover:border-blue-500 transition-all cursor-pointer';
        div.innerHTML = `
            <img src="${p.url}" class="w-full h-full object-cover">
            <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-all">
                <button onclick="event.stopPropagation(); deletePreset(${index})" class="p-1.5 bg-red-600 rounded-full text-white">
                    <i data-lucide="trash-2" class="w-3 h-3"></i>
                </button>
            </div>
        `;
        div.onclick = () => {
            // Apply preset
            if (p.mediaFiles) mediaFiles = { ...mediaFiles, ...p.mediaFiles };
            if (p.parameters) parameters = { ...parameters, ...p.parameters };
            if (p.bypassedNodes) bypassedNodes = { ...bypassedNodes, ...p.bypassedNodes };
            renderMediaInputs();
            renderParameters();
        };
        container.appendChild(div);
    });
    lucide.createIcons();
}

async function addPreset() {
    if (!currentWorkflow) return alert(getTranslation('add_preset_hint'));

    const container = document.getElementById('output-media-container');
    const img = container.querySelector('img');
    if (!img) return alert('Generate an image first to add it as a preset');

    const preset = {
        url: img.src,
        mediaFiles: { ...mediaFiles },
        parameters: { ...parameters },
        bypassedNodes: { ...bypassedNodes }
    };

    currentPresets.push(preset);
    renderPresets(currentPresets);
}

function deletePreset(index) {
    if (confirm(getTranslation('confirm_delete_preset'))) {
        currentPresets.splice(index, 1);
        renderPresets(currentPresets);
    }
}

async function deleteWorkflow(id) {
    if (!confirm(getTranslation('confirm_delete_workflow'))) return;
    try {
        await fetch(`/api/workflows/delete/${id}`, { method: 'DELETE' });
        loadWorkflows();
    } catch (e) { console.error(e); }
}

async function refreshOutputs() {
    try {
        const res = await fetch('/api/outputs');
        const data = await res.json();
        const gallery = document.getElementById('outputs-gallery');
        gallery.innerHTML = '';

        if (data.files.length === 0) {
            gallery.innerHTML = '<div class="col-span-full text-center py-12 text-slate-600 italic" data-i18n="no_outputs">No items found</div>';
            translatePage(localStorage.getItem('preferredLanguage') || 'en');
            return;
        }

        data.files.forEach(file => {
            const card = document.createElement('div');
            card.className = 'slate-card rounded-lg overflow-hidden group cursor-pointer relative aspect-square';
            card.innerHTML = file.type === 'video'
                ? `<video src="${file.url}" class="w-full h-full object-cover"></video><div class="absolute inset-0 flex items-center justify-center bg-black/20"><i data-lucide="play" class="text-white w-8 h-8"></i></div>`
                : `<img src="${file.url}" class="w-full h-full object-cover">`;
            card.onclick = () => showModal(file.url, file.type);
            gallery.appendChild(card);
        });
        lucide.createIcons();
    } catch (e) { console.error(e); }
}

function showModal(url, type) {
    const modal = document.getElementById('media-modal');
    const content = document.getElementById('modal-content');
    content.innerHTML = type === 'video'
        ? `<video src="${url}" controls autoplay class="max-w-full max-h-full"></video>`
        : `<img src="${url}" class="max-w-full max-h-full object-contain">`;
    modal.classList.remove('hidden');
}

// Event Listeners
document.getElementById('upload-btn').onclick = () => document.getElementById('workflow-file').click();
document.getElementById('workflow-file').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('workflow', file);
    const res = await fetch('/api/workflow/upload', { method: 'POST', body: formData });
    const data = await res.json();
    setupWorkflow(data);
};

document.getElementById('save-workflow-btn').onclick = saveWorkflow;
document.getElementById('add-preset-btn').onclick = addPreset;
document.getElementById('save-ui-config').onclick = saveUIConfig;
document.getElementById('generate-btn').onclick = runWorkflow;
document.getElementById('refresh-outputs-btn').onclick = refreshOutputs;
document.getElementById('close-modal').onclick = () => document.getElementById('media-modal').classList.add('hidden');
document.getElementById('update-url-btn').onclick = async () => {
    const comfyuiUrl = document.getElementById('comfy-url-input').value;
    const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comfyuiUrl })
    });
    const data = await res.json();
    if (data.success) alert(getTranslation('url_updated'));
};

document.getElementById('select-all-btn').onclick = () => {
    document.querySelectorAll('.param-visibility-check').forEach(c => {
        c.checked = true;
        uiConfig.visibleParams[c.dataset.key] = true;
    });
};

document.getElementById('deselect-all-btn').onclick = () => {
    document.querySelectorAll('.param-visibility-check').forEach(c => {
        c.checked = false;
        uiConfig.visibleParams[c.dataset.key] = false;
    });
};

// Initial Load
loadWorkflows();
refreshOutputs();
setInterval(async () => {
    try {
        const res = await fetch('/api/health');
        const data = await res.json();
        const badge = document.getElementById('status-badge');
        if (data.comfyui === 'connected') {
            badge.className = 'flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-900/30 border border-emerald-500/50 text-emerald-400 text-sm font-medium';
            badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-500"></span><span data-i18n="connected">Connected</span>';
        } else {
            badge.className = 'flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-900/30 border border-red-500/50 text-red-400 text-sm font-medium';
            badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span><span data-i18n="disconnected">Disconnected</span>';
        }
        translatePage(localStorage.getItem('preferredLanguage') || 'en');
    } catch (e) {}
}, 5000);
