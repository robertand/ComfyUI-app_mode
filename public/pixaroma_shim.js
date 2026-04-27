
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

    /* Target all possible Pixaroma editor class names */
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
        console.log("[Shim] Registered:", ext.name);
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

export async function openPixaromaEditor(nodeType, nodeId, initialData, onSave) {
    const sid = String(nodeId);
    console.log(`[Shim] Open Request for Node ${sid} (${nodeType})`);
    activeEditorCallback = onSave;
    window._pixaroma_active_node_id = sid; // Global tag for hijacked methods

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

    // Ensure session truth is set from initial load if not already there
    if (!window._pixaroma_node_data.has(sid)) window._pixaroma_node_data.set(sid, parsedData);
    const sessionData = window._pixaroma_node_data.get(sid);

    if (OriginalClass && !OriginalClass._hijacked) {
        const origOpen = OriginalClass.prototype.open;
        OriginalClass.prototype.open = function(data) {
            // FIX: Always prioritize the global session truth for the active node ID
            const targetId = window._pixaroma_active_node_id;
            const latestData = window._pixaroma_node_data.get(targetId);
            const openData = (latestData && Object.keys(latestData).length > 0) ? latestData : (data || sessionData);

            console.log(`[Shim] ${editorClassName}.open() - Applying Data for Node ${targetId}:`, openData);

            // Re-apply nodeId to the instance for onSave context
            this._nodeId = targetId;

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

            return origOpen.call(this, openData);
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

    // Sync widgets again
    mockNode.widgets.forEach(w => {
        const data = window._pixaroma_node_data.get(sid);
        if ((w.name.toLowerCase().includes('widget') || w.name.toLowerCase().includes('scene') || w.name.toLowerCase().includes('paint')) && data) {
            w.value = data;
            if (typeof w.callback === 'function') w.callback.call(mockNode, data, mockNode);
        }
    });

    const openButton = mockNode.widgets.find(w => w.type === 'button' && (w.name.toLowerCase().includes('open') || w.name.toLowerCase().includes('editor')));
    if (openButton && typeof openButton.callback === 'function') {
        setTimeout(() => {
            console.log(`[Shim] Triggering Callback for Node ${sid}`);
            openButton.callback.call(mockNode, openButton, mockNode);
        }, 500); // 500ms delay to ensure heavy UI extensions like 3D Builder are fully ready
    } else {
        throw new Error(`Trigger button not found for ${nodeType}`);
    }
}

function getExtensionName(nodeType) {
    const map = {
        Pixaroma3D: 'Pixaroma.3DEditor', PixaromaPaint: 'Pixaroma.PaintEditor',
        PixaromaImageComposition: 'Pixaroma.ComposerEditor', PixaromaCrop: 'Pixaroma.CropEditor',
        PixaromaImageCompare: 'Pixaroma.CompareEditor', Pixaroma3DBuilder: 'Pixaroma.3DBuilder'
    };
    return map[nodeType] || '';
}

function getEditorClass(nodeType) {
    const map = {
        Pixaroma3D: 'Pixaroma3DEditor', PixaromaPaint: 'PixaromaPaintEditor',
        PixaromaImageComposition: 'PixaromaComposerEditor', PixaromaCrop: 'PixaromaCropEditor',
        PixaromaImageCompare: 'PixaromaCompareEditor', Pixaroma3DBuilder: 'Pixaroma3DBuilder'
    };
    return map[nodeType] || '';
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
        const paths = [`${base}index.js`, `${base}index.mjs`, `/pixaroma/assets/${subFolder}/index.js`, `/extensions/${v}/js/pixaroma_${subFolder}.js` ];
        for (const p of paths) {
            try {
                const module = await import(p);
                if (module[editorClassName]) {
                    window._pixaroma_classes[editorClassName] = module[editorClassName];
                    window[editorClassName] = module[editorClassName];
                    return;
                }
            } catch (e) {}
        }
    }
    throw new Error(`Failed to load module for ${nodeType}`);
}
