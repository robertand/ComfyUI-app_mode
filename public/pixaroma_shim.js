
// Pixaroma Bridge / Shim
// This file provides the necessary environment for Pixaroma editors to run outside of ComfyUI.

window._pixaroma_extensions = {};
window._pixaroma_classes = {};

// Inject Pixaroma CSS to ensure it's full-screen and visible
const style = document.createElement('style');
style.textContent = `
    /* Force Pixaroma overlays to be fixed and high z-index */
    .pxf-overlay, .pxf-editor-overlay, .pixaroma-3d-editor, .pixaroma-paint-editor,
    .pixaroma-composer-editor, .pixaroma-crop-editor {
        position: fixed !important;
        inset: 0 !important;
        top: 0 !important;
        left: 0 !important;
        right: 0 !important;
        bottom: 0 !important;
        z-index: 999999 !important; /* Extremely high */
        background: #0f172a !important;
        display: flex !important;
        flex-direction: column !important;
        opacity: 1 !important;
        visibility: visible !important;
        pointer-events: auto !important;
        width: 100vw !important;
        height: 100vh !important;
    }

    /* Ensure the editor layout takes full space */
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

    /* Fix for potential missing fonts/icons */
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
    graph: {
        serialize: () => ({}),
        getNodeById: (id) => null,
        _nodes: []
    },
    canvas: {
        setDirty: () => {}
    }
};

window.LGraphCanvas = window.LGraphCanvas || {
    prototype: {
        setDirty: () => {}
    }
};

window.LiteGraph = window.LiteGraph || {
    NODE_TITLE_HEIGHT: 30,
    registerNodeType: () => {}
};

// Global interceptor for editor opening
let activeEditorCallback = null;

export async function openPixaromaEditor(nodeType, initialData, onSave) {
    console.log(`Opening Pixaroma Editor for ${nodeType}`);

    // Store callback globally for interception
    activeEditorCallback = onSave;

    // 1. Ensure the editor extension is loaded
    await loadPixaromaExtension(nodeType);

    const extName = getExtensionName(nodeType);
    const ext = window._pixaroma_extensions[extName];

    if (!ext) {
        throw new Error(`Extension ${extName} not found for node type ${nodeType}`);
    }

    // Hijack prototype.open before we do anything
    const editorClassName = getEditorClass(nodeType);
    const OriginalClass = window._pixaroma_classes[editorClassName];

    if (OriginalClass && !OriginalClass._hijacked) {
        const origOpen = OriginalClass.prototype.open;
        OriginalClass.prototype.open = function(data) {
            console.log(`${editorClassName}.open() hijacked`);

            // Ensure onSave is hijacked on this instance
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
                set: (val) => {
                    internalOnSave = val;
                },
                configurable: true
            });

            const dataToOpen = initialData || data;
            return origOpen.call(this, dataToOpen);
        };
        OriginalClass._hijacked = true;
    }

    // 2. Mock a ComfyUI node
    const mockNode = {
        comfyClass: nodeType,
        widgets: [],
        type: nodeType,
        id: 1,
        properties: {},
        size: [300, 300],
        serialize: function() { return { widgets_values: this.widgets.map(w => w.value) }; },
        addWidget: function(type, name, value, callback, options) {
            const w = {
                type,
                name,
                value: (name === 'SceneWidget' || name === 'PaintWidget' || name === 'ComposerWidget' || name === 'CropWidget') ? initialData : value,
                callback,
                options
            };
            this.widgets.push(w);
            return w;
        },
        addDOMWidget: function(name, type, element, options) {
            const w = { name, type, element, options, value: initialData };
            this.widgets.push(w);
            return w;
        },
        setDirtyCanvas: () => { console.log("Canvas set dirty"); },
        onRemoved: () => {}
    };

    // 3. Initialize the node through the extension
    if (ext.nodeCreated) {
        await ext.nodeCreated(mockNode);
    }

    // 4. Find the "Open" button widget and trigger it
    const openButton = mockNode.widgets.find(w => w.type === 'button' && (w.name.toLowerCase().includes('open') || w.name.toLowerCase().includes('editor')));
    if (openButton && typeof openButton.callback === 'function') {
        console.log("Triggering Pixaroma button callback");
        openButton.callback.call(mockNode, mockNode);
    } else {
        console.error("Available widgets:", mockNode.widgets);
        throw new Error(`Could not find Open button for Pixaroma node ${nodeType}`);
    }
}

function getExtensionName(nodeType) {
    switch(nodeType) {
        case 'Pixaroma3D': return 'Pixaroma.3DEditor';
        case 'PixaromaPaint': return 'Pixaroma.PaintEditor';
        case 'PixaromaImageComposition': return 'Pixaroma.ComposerEditor';
        case 'PixaromaCrop': return 'Pixaroma.CropEditor';
        default: return '';
    }
}

function getEditorClass(nodeType) {
    switch(nodeType) {
        case 'Pixaroma3D': return 'Pixaroma3DEditor';
        case 'PixaromaPaint': return 'PixaromaPaintEditor';
        case 'PixaromaImageComposition': return 'PixaromaComposerEditor';
        case 'PixaromaCrop': return 'PixaromaCropEditor';
        default: return '';
    }
}

async function loadPixaromaExtension(nodeType) {
    const extName = getExtensionName(nodeType);
    if (window._pixaroma_extensions[extName]) return;

    let modulePath = '';
    switch(nodeType) {
        case 'Pixaroma3D': modulePath = '/pixaroma/assets/3d/index.js'; break;
        case 'PixaromaPaint': modulePath = '/pixaroma/assets/paint/index.js'; break;
        case 'PixaromaImageComposition': modulePath = '/pixaroma/assets/composer/index.js'; break;
        case 'PixaromaCrop': modulePath = '/pixaroma/assets/crop/index.js'; break;
    }

    if (modulePath) {
        console.log(`Loading Pixaroma module: ${modulePath}`);
        try {
            const module = await import(modulePath);
            const editorClassName = getEditorClass(nodeType);
            if (module[editorClassName]) {
                window._pixaroma_classes[editorClassName] = module[editorClassName];
                window[editorClassName] = module[editorClassName];
            }
        } catch (e) {
            console.error(`Failed to load Pixaroma module ${modulePath}:`, e);
            throw e;
        }
    }
}
