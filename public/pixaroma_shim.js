
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

    @font-face {
        font-family: 'Pixaroma';
        src: url('/pixaroma/assets/fonts/pixaroma.woff2') format('woff2');
    }
`;
document.head.appendChild(style);

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
        this.add = (n) => { if (n) this._nodes.push(n); };
        this.getNodeById = (id) => this._nodes.find(n => n.id === id);
    }
};

let activeEditorCallback = null;

export async function openPixaromaEditor(nodeType, initialData, onSave) {
    console.log(`Opening Pixaroma Editor for ${nodeType} with data:`, initialData);
    activeEditorCallback = onSave;

    await loadPixaromaExtension(nodeType);

    const extName = getExtensionName(nodeType);
    const ext = window._pixaroma_extensions[extName];

    if (!ext) throw new Error(`Extension ${extName} not found`);

    const editorClassName = getEditorClass(nodeType);
    const OriginalClass = window._pixaroma_classes[editorClassName];

    // Process initialData - ensure it's an object if it's a string
    let parsedData = initialData;
    if (typeof initialData === 'string' && (initialData.startsWith('{') || initialData.startsWith('['))) {
        try { parsedData = JSON.parse(initialData); } catch(e) { console.error("Shim: Error parsing initial data", e); }
    }

    if (OriginalClass && !OriginalClass._hijacked) {
        const origOpen = OriginalClass.prototype.open;
        OriginalClass.prototype.open = function(data) {
            console.log(`${editorClassName}.open() called with:`, data);

            // If we have parsedData from our closure, prioritize it if the call data is empty or default
            const finalData = (parsedData && Object.keys(parsedData).length > 0) ? parsedData : data;

            let internalOnSave = null;
            Object.defineProperty(this, 'onSave', {
                get: () => {
                    return (jsonStr, dataURL) => {
                        console.log(`${editorClassName} triggered onSave`);
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
            // If this is the main state widget, pre-fill it with our parsedData
            const isStateWidget = name === 'SceneWidget' || name === 'PaintWidget' || name === 'ComposerWidget' || name === 'CropWidget';
            const finalValue = (isStateWidget && parsedData) ? parsedData : value;

            const w = { type, name, value: finalValue || '', callback, options };
            this.widgets.push(w);
            return w;
        },
        addDOMWidget: function(name, type, element, options) {
            const isStateWidget = name === 'SceneWidget' || name === 'PaintWidget' || name === 'ComposerWidget' || name === 'CropWidget';
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

    // After nodeCreated, check if any widget needs to be updated with parsedData
    mockNode.widgets.forEach(w => {
        const isStateWidget = w.name === 'SceneWidget' || w.name === 'PaintWidget' || w.name === 'ComposerWidget' || w.name === 'CropWidget';
        if (isStateWidget && parsedData) {
            w.value = parsedData;
        }
    });

    const openButton = mockNode.widgets.find(w => w.type === 'button' && (w.name.toLowerCase().includes('open') || w.name.toLowerCase().includes('editor')));
    if (openButton && typeof openButton.callback === 'function') {
        openButton.callback.call(mockNode, mockNode);
    } else {
        throw new Error(`Could not find trigger button for ${nodeType}`);
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
            console.log(`Trying Pixaroma load: ${p}`);
            try {
                const module = await import(p);
                if (module[editorClassName]) {
                    window._pixaroma_classes[editorClassName] = module[editorClassName];
                    window[editorClassName] = module[editorClassName];
                    console.log(`Successfully loaded ${editorClassName} from ${p}`);
                    return;
                }
            } catch (e) {
                errors.push(`${p}: ${e.message}`);
            }
        }
    }
    console.error("All Pixaroma load attempts failed:", errors);
    throw new Error(`Failed to load Pixaroma module for ${nodeType}. Check console for details.`);
}
