
// Pixaroma Bridge / Shim
// This file provides the necessary environment for Pixaroma editors to run outside of ComfyUI.

window._pixaroma_extensions = {};
window._pixaroma_classes = {};
window._pixaroma_active_node = null;

// Inject standard ComfyUI and Pixaroma CSS variables
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

    /* Force Pixaroma overlays to be fixed and high z-index */
    .pxf-overlay, .pxf-editor-overlay, .pixaroma-3d-editor, .pixaroma-paint-editor,
    .pixaroma-composer-editor, .pixaroma-crop-editor {
        position: fixed !important;
        inset: 0 !important;
        top: 0 !important;
        left: 0 !important;
        right: 0 !important;
        bottom: 0 !important;
        z-index: 999999 !important;
        background: #0f172a !important;
        display: flex !important;
        flex-direction: column !important;
        opacity: 1 !important;
        visibility: visible !important;
        pointer-events: auto !important;
        width: 100vw !important;
        height: 100vh !important;
    }

    .pxf-editor-layout, .pxf-body {
        height: 100% !important;
        width: 100% !important;
        flex: 1 !important;
        display: flex !important;
    }

    .pxf-titlebar {
        display: flex !important;
        z-index: 1000001 !important;
    }

    .pxf-workspace {
        flex: 1 !important;
        position: relative !important;
        background: #000 !important;
    }

    /* Save Indicator */
    #pixaroma-save-toast {
        position: fixed;
        bottom: 2rem;
        left: 50%;
        transform: translateX(-50%);
        background: #10b981;
        color: white;
        padding: 0.75rem 1.5rem;
        border-radius: 9999px;
        font-weight: 600;
        z-index: 1000002;
        box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
        display: none;
        animation: toast-in 0.3s ease-out;
    }
    @keyframes toast-in { from { bottom: 0; opacity: 0; } to { bottom: 2rem; opacity: 1; } }

    @font-face {
        font-family: 'Pixaroma';
        src: url('/pixaroma/assets/fonts/pixaroma.woff2') format('woff2');
    }
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
        console.log("Shim: registered extension", ext.name);
        window._pixaroma_extensions[ext.name] = ext;
    },
    ui: {
        settings: {
            getSettingValue: (id) => {
                const s = JSON.parse(localStorage.getItem('pixaroma_settings') || '{}');
                return s[id] || null;
            }
        }
    },
    api_base: window.location.origin,
    graph: {
        serialize: () => ({}),
        getNodeById: (id) => (window._pixaroma_active_node && window._pixaroma_active_node.id === id) ? window._pixaroma_active_node : null,
        _nodes: [],
        _groups: []
    },
    canvas: {
        setDirty: () => {},
        draw: () => {}
    }
};

window.ComfyApp = window.ComfyApp || window.app;

window.api = window.api || {
    api_base: '',
    fetchApi: async (route, options) => {
        const url = route.startsWith('/') ? route : `/${route}`;
        return await fetch(url, options);
    }
};

window.LGraphCanvas = window.LGraphCanvas || function() {};
window.LGraphCanvas.prototype = window.LGraphCanvas.prototype || {
    setDirty: () => {},
    draw: () => {}
};

window.LiteGraph = window.LiteGraph || {
    NODE_TITLE_HEIGHT: 30,
    registerNodeType: () => {},
    createNode: () => ({ widgets: [], addWidget: () => ({}) }),
    LGraph: function() {
        this._nodes = [];
        this.add = (n) => { if (n) { n.graph = this; this._nodes.push(n); } };
        this.getNodeById = (id) => this._nodes.find(n => n.id === id);
    }
};

let activeEditorCallback = null;

export async function openPixaromaEditor(nodeType, initialData, onSave) {
    console.log(`[Shim] Opening Editor: ${nodeType}`);
    activeEditorCallback = onSave;

    await loadPixaromaExtension(nodeType);

    const extName = getExtensionName(nodeType);
    const ext = window._pixaroma_extensions[extName];
    if (!ext) throw new Error(`Extension ${extName} not found`);

    const editorClassName = getEditorClass(nodeType);
    const OriginalClass = window._pixaroma_classes[editorClassName];

    let parsedData = initialData;
    if (typeof initialData === 'string' && (initialData.startsWith('{') || initialData.startsWith('['))) {
        try { parsedData = JSON.parse(initialData); } catch(e) { console.error("[Shim] Parse error", e); }
    }

    if (OriginalClass && !OriginalClass._hijacked) {
        const origOpen = OriginalClass.prototype.open;
        OriginalClass.prototype.open = function(data) {
            console.log(`[Shim] ${editorClassName}.open() called`);
            const finalData = (parsedData && Object.keys(parsedData).length > 0) ? parsedData : data;

            let internalOnSave = null;
            Object.defineProperty(this, 'onSave', {
                get: () => {
                    return (jsonStr, dataURL) => {
                        console.log(`[Shim] ${editorClassName} Save Intercepted`);
                        showToast();
                        if (internalOnSave) internalOnSave.call(this, jsonStr, dataURL);
                        if (activeEditorCallback) activeEditorCallback(jsonStr, dataURL);
                        if (typeof this.unmount === 'function') this.unmount();
                        else if (typeof this.close === 'function') this.close();
                    };
                },
                set: (val) => { internalOnSave = val; },
                configurable: true
            });
            return origOpen.call(this, finalData);
        };
        OriginalClass._hijacked = true;
    }

    const mockNode = {
        comfyClass: nodeType,
        widgets: [],
        type: nodeType,
        id: 999,
        properties: {},
        size: [300, 300],
        serialize: function() { return { widgets_values: this.widgets.map(w => w.value) }; },
        addWidget: function(type, name, value, callback, options) {
            const isStateWidget = ['SceneWidget', 'PaintWidget', 'ComposerWidget', 'CropWidget'].includes(name);
            const finalValue = (isStateWidget && parsedData) ? parsedData : value;
            const w = { type, name, value: finalValue || '', callback, options };
            this.widgets.push(w);
            return w;
        },
        addDOMWidget: function(name, type, element, options) {
            const isStateWidget = ['SceneWidget', 'PaintWidget', 'ComposerWidget', 'CropWidget'].includes(name);
            const finalValue = (isStateWidget && parsedData) ? parsedData : initialData;
            const w = { name, type, element, options, value: finalValue };
            this.widgets.push(w);
            return w;
        },
        setDirtyCanvas: () => {},
        onRemoved: () => {}
    };

    window._pixaroma_active_node = mockNode;
    window.app.graph._nodes = [mockNode];

    if (ext.nodeCreated) await ext.nodeCreated(mockNode);

    // Deep sync widgets with parsed data after creation
    mockNode.widgets.forEach(w => {
        const isStateWidget = ['SceneWidget', 'PaintWidget', 'ComposerWidget', 'CropWidget'].includes(w.name);
        if (isStateWidget && parsedData) {
            w.value = parsedData;
            if (typeof w.callback === 'function') w.callback.call(mockNode, parsedData);
        }
    });

    const openButton = mockNode.widgets.find(w => w.type === 'button' && (w.name.toLowerCase().includes('open') || w.name.toLowerCase().includes('editor')));
    if (openButton && typeof openButton.callback === 'function') {
        openButton.callback.call(mockNode, mockNode);
    } else {
        throw new Error(`Trigger button not found for ${nodeType}`);
    }
}

function getExtensionName(nodeType) {
    const map = { 'Pixaroma3D': 'Pixaroma.3DEditor', 'PixaromaPaint': 'Pixaroma.PaintEditor', 'PixaromaImageComposition': 'Pixaroma.ComposerEditor', 'PixaromaCrop': 'Pixaroma.CropEditor' };
    return map[nodeType] || '';
}

function getEditorClass(nodeType) {
    const map = { 'Pixaroma3D': 'Pixaroma3DEditor', 'PixaromaPaint': 'PixaromaPaintEditor', 'PixaromaImageComposition': 'PixaromaComposerEditor', 'PixaromaCrop': 'PixaromaCropEditor' };
    return map[nodeType] || '';
}

async function loadPixaromaExtension(nodeType) {
    const extName = getExtensionName(nodeType);
    if (window._pixaroma_extensions[extName]) return;

    const variants = ['ComfyUI-Pixaroma', 'ComfyUI_Pixaroma', 'pixaroma', 'Pixaroma', 'comfyui-pixaroma'];
    const editorClassName = getEditorClass(nodeType);
    const sub = nodeType.replace('Pixaroma', '').toLowerCase();
    const subFolder = sub === 'imagecomposition' ? 'composer' : sub;

    const errors = [];
    for (const v of variants) {
        const base = `/extensions/${v}/js/${subFolder}/`;
        const paths = [ `${base}index.js`, `${base}index.mjs`, `/pixaroma/assets/${subFolder}/index.js` ];
        for (const p of paths) {
            console.log(`[Shim] Attempting: ${p}`);
            try {
                const module = await import(p);
                if (module[editorClassName]) {
                    window._pixaroma_classes[editorClassName] = module[editorClassName];
                    window[editorClassName] = module[editorClassName];
                    console.log(`[Shim] Success: ${editorClassName} from ${p}`);
                    return;
                }
            } catch (e) { errors.push(`${p}: ${e.message}`); }
        }
    }
    console.error("[Shim] All attempts failed:", errors);
    throw new Error(`Module load failed for ${nodeType}. Check console.`);
}
