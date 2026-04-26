
// Pixaroma Bridge / Shim
// This file provides the necessary environment for Pixaroma editors to run outside of ComfyUI.

window._pixaroma_extensions = {};
window._pixaroma_classes = {};

export async function openPixaromaEditor(nodeType, initialData, onSave) {
    console.log(`Opening Pixaroma Editor for ${nodeType}`);

    // 1. Ensure the editor extension is loaded
    await loadPixaromaExtension(nodeType);

    const extName = getExtensionName(nodeType);
    const ext = window._pixaroma_extensions[extName];

    if (!ext) {
        throw new Error(`Extension ${extName} not found for node type ${nodeType}`);
    }

    // 2. Mock a ComfyUI node
    const mockNode = {
        comfyClass: nodeType,
        widgets: [],
        addWidget: function(type, name, value, callback, options) {
            const w = { type, name, value, callback, options };
            this.widgets.push(w);
            return w;
        },
        addDOMWidget: function(name, type, element, options) {
            const w = { name, type, element, options, value: initialData };
            this.widgets.push(w);
            return w;
        },
        setDirtyCanvas: () => {},
        onRemoved: () => {}
    };

    // 3. Initialize the node through the extension
    if (ext.nodeCreated) {
        await ext.nodeCreated(mockNode);
    }

    // 4. Find the "Open" button widget and trigger it
    const openButton = mockNode.widgets.find(w => w.type === 'button' && w.name.startsWith('Open'));
    if (openButton && typeof openButton.callback === 'function') {

        const originalCallback = openButton.callback;
        openButton.callback = function() {
            const editorClassName = getEditorClass(nodeType);
            const OriginalClass = window._pixaroma_classes[editorClassName];

            if (OriginalClass) {
                // Temporary wrapper to intercept constructor and onSave
                const Wrapper = function(...args) {
                    const instance = new OriginalClass(...args);

                    // Use defineProperty to ensure we catch internal assignments to onSave
                    let internalOnSave = null;
                    Object.defineProperty(instance, 'onSave', {
                        get: () => {
                            return function(jsonStr, dataURL) {
                                if (internalOnSave) internalOnSave.apply(instance, arguments);
                                onSave(jsonStr, dataURL);
                            };
                        },
                        set: (val) => {
                            internalOnSave = val;
                        },
                        configurable: true
                    });

                    // Wrap open method to pass initial data
                    const originalOpen = instance.open;
                    instance.open = function(data) {
                        const dataToOpen = initialData || data;
                        return originalOpen.call(instance, dataToOpen);
                    };

                    return instance;
                };
                Wrapper.prototype = OriginalClass.prototype;

                // Inject into window for the duration of the callback
                window[editorClassName] = Wrapper;
            }

            try {
                originalCallback.apply(this, arguments);
            } finally {
                // Restore original class
                if (OriginalClass) window[editorClassName] = OriginalClass;
            }
        };

        openButton.callback();
    } else {
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
            // Capture classes from module exports
            const editorClassName = getEditorClass(nodeType);
            if (module[editorClassName]) {
                window._pixaroma_classes[editorClassName] = module[editorClassName];
                // Also put on window temporarily as some scripts might expect it there
                window[editorClassName] = module[editorClassName];
            }
        } catch (e) {
            console.error(`Failed to load Pixaroma module ${modulePath}:`, e);
            throw e;
        }
    }
}
