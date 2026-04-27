
// Pixaroma Bridge / Shim
// This file provides the necessary environment for Pixaroma editors to run outside of ComfyUI.

window._pixaroma_extensions = {};
window._pixaroma_classes = {};
window._pixaroma_active_node = null;
window._pixaroma_active_node_id = null;
window._pixaroma_node_data = new Map(); // Global session truth

// CSS Layout Fixes
const style = document.createElement('style');
style.textContent = `
    :root {
        --comfy-menu-bg: #1e1e1e;
        --comfy-input-bg: #2a2a2a;
        --comfy-text-color: #eee;
        --bg-color: #0f172a;
        --fg-color: #e0e0e0;
        --border-color: #334155;
    }

    .pxf-overlay, .pxf-editor-overlay, .pixaroma-3d-editor, .pixaroma-paint-editor,
    .pixaroma-composer-editor, .pixaroma-crop-editor, .pixaroma-compare-editor,
    .pixaroma-3d-builder, .pixaroma-paint-studio {
        position: fixed !important; inset: 0 !important; z-index: 999999 !important;
        background: #0f172a !important; display: flex !important; flex-direction: column !important;
        opacity: 1 !important; visibility: visible !important; pointer-events: auto !important;
        width: 100vw !important; height: 100vh !important;
    }

    .pxf-editor-layout, .pxf-body { height: 100% !important; width: 100% !important; flex: 1 !important; display: flex !important; }
    .pxf-workspace { flex: 1 !important; position: relative !important; background: #000 !important; }

    #pixaroma-save-toast {
        position: fixed; bottom: 2rem; left: 50%; transform: translateX(-50%);
        background: #10b981; color: white; padding: 0.75rem 1.5rem; border-radius: 9999px;
        font-weight: 600; z-index: 1000002; display: none; animation: toast-in 0.3s ease-out;
    }
    @keyframes toast-in { from { bottom: 0; opacity: 0; } to { bottom: 2rem; opacity: 1; } }
`;
document.head.appendChild(style);

const toast = document.createElement('div');
toast.id = 'pixaroma-save-toast';
toast.textContent = 'Changes Saved Successfully';
document.body.appendChild(toast);

function showToast() {
    toast.style.display = 'block';
    setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

// Robust Mock for ComfyUI environment
window.app = window.app || {
    registerExtension: (ext) => {
        console.log("[Shim] Extension Registered:", ext.name);
        window._pixaroma_extensions[ext.name] = ext;
    },
    ui: { settings: { getSettingValue: (id) => JSON.parse(localStorage.getItem('pixaroma_settings') || '{}')[id] || null } },
    api_base: window.location.origin,
    graph: {
        serialize: () => ({ nodes: window._pixaroma_active_node ? [window._pixaroma_active_node] : [] }),
        getNodeById: (id) => (window._pixaroma_active_node && String(window._pixaroma_active_node.id) === String(id)) ? window._pixaroma_active_node : null
    }
};

window.ComfyApp = window.ComfyApp || window.app;
window.api = window.api || { fetchApi: (r, o) => fetch(r.startsWith('/') ? r : `/${r}`, o) };
window.LiteGraph = window.LiteGraph || {
    NODE_TITLE_HEIGHT: 30, registerNodeType: () => {},
    createNode: () => ({ widgets: [], addWidget: () => ({}) }),
    LGraph: function() { this._nodes = []; this.add = (n) => { n.graph = this; this._nodes.push(n); }; this.getNodeById = (id) => this._nodes.find(n => String(n.id) === String(id)); }
};

let activeEditorCallback = null;

function applyDataToEditor(instance, data) {
    if (!instance || !data || Object.keys(data).length === 0) return;
    try {
        // Anti-cube / Anti-default logic - only clear if it looks like a default cube and we are replacing it
        if (instance.scene && instance.scene.traverse) {
            const toRemove = [];
            let meshCount = 0;
            instance.scene.traverse(obj => { if (obj.type === 'Mesh') meshCount++; });

            instance.scene.traverse(obj => {
                const isMesh = obj.type === 'Mesh';
                const isDefaultName = obj.name.toLowerCase() === 'cube' || obj.name === 'Mesh' || !obj.name;
                if (isMesh && isDefaultName && obj.geometry && (obj.geometry.type === 'BoxGeometry' || obj.geometry.type === 'BoxBufferGeometry')) {
                    // Only nuke it if it's one of very few objects (likely default) or if we haven't successfully loaded our data yet
                    if (meshCount < 3 || !instance._data_applied_successfully) {
                        toRemove.push(obj);
                    }
                }
            });
            if (toRemove.length > 0) {
                console.log(`[Shim] Clearing ${toRemove.length} potential default objects...`);
                toRemove.forEach(obj => {
                    if (obj.parent) obj.parent.remove(obj);
                    if (obj.geometry) obj.geometry.dispose();
                    if (obj.material) {
                        if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
                        else obj.material.dispose();
                    }
                });
            }
        }

        console.log("[Shim] Applying session data to editor instance...");
        if (typeof instance.setProjectData === 'function') { instance.setProjectData(data); instance._data_applied_successfully = true; }
        else if (typeof instance.loadData === 'function') { instance.loadData(data); instance._data_applied_successfully = true; }
        else if (typeof instance.loadProject === 'function') { instance.loadProject(data); instance._data_applied_successfully = true; }
        else if (instance.project && typeof instance.project.load === 'function') { instance.project.load(data); instance._data_applied_successfully = true; }
        else if (instance.scene && typeof instance.scene.load === 'function') { instance.scene.load(data); instance._data_applied_successfully = true; }
        else if (instance.load && typeof instance.load === 'function') { instance.load(data); instance._data_applied_successfully = true; }

    } catch(e) { console.error("[Shim] Error applying data:", e); }
}

export async function openPixaromaEditor(nodeType, nodeId, initialData, onSave) {
    const sid = String(nodeId);
    console.log(`[Shim] Open Request for Node ${sid} (${nodeType})`);
    activeEditorCallback = onSave;
    window._pixaroma_active_node_id = sid;

    await loadPixaromaExtension(nodeType);

    const extName = getExtensionName(nodeType);
    const ext = window._pixaroma_extensions[extName];
    if (!ext) throw new Error(`Extension ${extName} not found`);

    const editorClassName = getEditorClass(nodeType);
    const OriginalClass = window._pixaroma_classes[editorClassName];

    let parsedData = initialData;
    if (typeof initialData === 'string' && (initialData.startsWith('{') || initialData.startsWith('['))) {
        try { parsedData = JSON.parse(initialData); } catch(e) {}
    }

    if (!window._pixaroma_node_data.has(sid)) window._pixaroma_node_data.set(sid, parsedData);
    const sessionData = window._pixaroma_node_data.get(sid);

    if (OriginalClass && !OriginalClass._hijacked) {
        const origOpen = OriginalClass.prototype.open;
        OriginalClass.prototype.open = function(data) {
            const targetId = this._nodeId || window._pixaroma_active_node_id;
            const latestData = window._pixaroma_node_data.get(targetId);
            const openData = (latestData && Object.keys(latestData).length > 0) ? latestData : (data || sessionData);

            console.log(`[Shim] ${editorClassName}.open() called for Node ${targetId}`);
            this._nodeId = targetId;

            applyDataToEditor(this, openData);

            if (!this._hijacked_save) {
                let internalOnSave = null;
                Object.defineProperty(this, 'onSave', {
                    get: () => (jsonStr, dataURL) => {
                        const saveId = this._nodeId || window._pixaroma_active_node_id;
                        console.log(`[Shim] Save Captured for Node ${saveId}`);
                        try {
                            const saved = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
                            window._pixaroma_node_data.set(saveId, saved);
                        } catch(e) { window._pixaroma_node_data.set(saveId, jsonStr); }

                        showToast();
                        if (internalOnSave) internalOnSave.call(this, jsonStr, dataURL);
                        if (activeEditorCallback) activeEditorCallback(jsonStr, dataURL);
                        if (typeof this.unmount === 'function') this.unmount();
                        else if (typeof this.close === 'function') this.close();
                    },
                    set: (val) => { internalOnSave = val; },
                    configurable: true
                });
                this._hijacked_save = true;
            }

            const res = origOpen.call(this, openData);
            [100, 300, 700, 1500].forEach(ms => setTimeout(() => applyDataToEditor(this, openData), ms));
            return res;
        };
        OriginalClass._hijacked = true;
    }

    const mockNode = {
        comfyClass: nodeType,
        widgets: [],
        type: nodeType,
        id: sid,
        properties: {},
        flags: {},
        size: [300, 300],
        serialize: function() { return { widgets_values: this.widgets.map(w => w.value) }; },
        addWidget: function(type, name, value, callback, options) {
            const data = window._pixaroma_node_data.get(this.id);
            const isTarget = name.toLowerCase().includes('widget') || name.toLowerCase().includes('scene') || name.toLowerCase().includes('paint') || name.toLowerCase().includes('compare');
            const finalValue = isTarget ? (data || value) : value;
            const w = { type, name, value: finalValue || '', callback, options };
            this.widgets.push(w);
            return w;
        },
        addDOMWidget: function(name, type, element, options) {
            const data = window._pixaroma_node_data.get(this.id);
            const isTarget = name.toLowerCase().includes('widget') || name.toLowerCase().includes('scene') || name.toLowerCase().includes('paint') || name.toLowerCase().includes('compare');
            const finalValue = isTarget ? (data || initialData) : initialData;
            const w = { name, type, element, options, value: finalValue };
            this.widgets.push(w);
            return w;
        },
        setDirtyCanvas: () => {},
        onRemoved: () => {}
    };

    window._pixaroma_active_node = mockNode;
    if (ext.nodeCreated) await ext.nodeCreated(mockNode);

    // Sync widgets
    mockNode.widgets.forEach(w => {
        const data = window._pixaroma_node_data.get(sid);
        const isTarget = w.name.toLowerCase().includes('widget') || w.name.toLowerCase().includes('scene') || w.name.toLowerCase().includes('paint') || w.name.toLowerCase().includes('composer') || w.name.toLowerCase().includes('compare');
        if (isTarget && data) {
            w.value = data;
            if (typeof w.callback === 'function') w.callback.call(mockNode, data, mockNode);
        }
    });

    const openButton = mockNode.widgets.find(w => w.type === 'button' &&
        (w.name.toLowerCase().includes('open') || w.name.toLowerCase().includes('editor') ||
         w.name.toLowerCase().includes('builder') || w.name.toLowerCase().includes('studio') ||
         w.name.toLowerCase().includes('composer') || w.name.toLowerCase().includes('compare')));
    if (openButton && typeof openButton.callback === 'function') {
        const OriginalClass = window._pixaroma_classes[editorClassName];
        if (OriginalClass) {
            const oldProtoOpen = OriginalClass.prototype.open;
            OriginalClass.prototype.open = function(d) {
                this._nodeId = sid;
                const finalData = window._pixaroma_node_data.get(sid) || d;
                return oldProtoOpen.call(this, finalData);
            };
        }

        setTimeout(() => {
            console.log(`[Shim] Triggering Open`);
            openButton.callback.call(mockNode, openButton, mockNode);
        }, 500);
    } else {
        throw new Error(`Trigger button not found for ${nodeType}`);
    }
}

function getExtensionName(nodeType) {
    const map = {
        Pixaroma3D: 'Pixaroma.3DEditor', PixaromaPaint: 'Pixaroma.PaintEditor',
        PixaromaPaintStudio: 'Pixaroma.PaintEditor',
        PixaromaImageComposition: 'Pixaroma.ComposerEditor',
        PixaromaImageComposer: 'Pixaroma.ComposerEditor',
        PixaromaCrop: 'Pixaroma.CropEditor',
        PixaromaImageCompare: 'Pixaroma.CompareEditor', Pixaroma3DBuilder: 'Pixaroma.3DBuilder'
    };
    return map[nodeType] || '';
}

function getEditorClass(nodeType) {
    const map = {
        Pixaroma3D: 'Pixaroma3DEditor', PixaromaPaint: 'PixaromaPaintEditor',
        PixaromaImageComposition: 'PixaromaComposerEditor', PixaromaCrop: 'PixaromaCropEditor',
        PixaromaImageCompare: 'PixaromaCompareEditor', Pixaroma3DBuilder: 'Pixaroma3DBuilder',
        PixaromaPaintStudio: 'PixaromaPaintStudio', PixaromaImageComposer: 'PixaromaComposerEditor',
        Pixaroma3DScene: 'Pixaroma3DEditor', PixaromaCanvas: 'PixaromaPaintEditor'
    };
    return map[nodeType] || (nodeType.replace('Pixaroma', '') + 'Editor');
}

async function loadPixaromaExtension(nodeType) {
    const extName = getExtensionName(nodeType);
    if (window._pixaroma_extensions[extName]) return;
    const variants = ['ComfyUI-Pixaroma', 'ComfyUI_Pixaroma', 'pixaroma', 'Pixaroma', 'comfyui-pixaroma'];
    const editorClassName = getEditorClass(nodeType);
    const sub = nodeType.replace('Pixaroma', '').toLowerCase();
    const folderMap = { '3d': '3d', 'paint': 'paint', 'imagecomposition': 'composer', 'crop': 'crop', 'imagecompare': 'compare', '3dbuilder': '3d' };
    const subFolder = folderMap[sub] || sub;

    for (const v of variants) {
        const base = `/extensions/${v}/js/${subFolder}/`;
        const altBase = `/extensions/${v}/${subFolder}/`;
        const paths = [
            `${altBase}index.js`, `${altBase}index.mjs`,
            `${base}index.js`, `${base}index.mjs`,
            `/pixaroma/assets/${subFolder}/index.js`,
            `/extensions/${v}/js/pixaroma_${subFolder}.js`
        ];
        for (const p of paths) {
            try {
                const module = await import(p);
                let exportedClass = module[editorClassName] || module['PaintEditor'] || module['ComposerEditor'] || module['CompareEditor'] || module['PixaromaPaintStudio'] || module['Pixaroma3DBuilder'] || module['PaintStudio'] || module['ComposerStudio'];

                if (!exportedClass) {
                    for (const key of Object.keys(module)) {
                        if (key.endsWith('Editor') || key.endsWith('Studio') || key.endsWith('Builder')) {
                            exportedClass = module[key]; break;
                        }
                    }
                }

                if (!exportedClass && window[editorClassName]) exportedClass = window[editorClassName];

                if (exportedClass) {
                    window._pixaroma_classes[editorClassName] = exportedClass;
                    window[editorClassName] = exportedClass;
                    console.log(`[Shim] Loaded ${editorClassName} from ${p}`);
                    return;
                }
            } catch (e) { console.warn(`[Shim] Failed import ${p}:`, e.message); }
        }
    }
    throw new Error(`Failed to load module for ${nodeType}`);
}
