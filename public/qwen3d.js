// Registry to store refresh functions for each 3D instance
window.qwen3DRefreshRegistry = {};

window.initQwenCamera3D = function(containerId, nodeId, parameters, currentWorkflow, uiConfig, bypassedNodes) {
    const containerEl = document.getElementById(containerId);
    if (!containerEl || !window.THREE) return;

    const getVal = (name) => {
        const key = `node_${nodeId}_${name}`;
        if (parameters[key] !== undefined) return parameters[key];
        const nodeGroup = currentWorkflow.advancedInputs.find(g => g.nodeId === nodeId);
        const input = nodeGroup?.inputs.find(i => i.inputName === name);
        return input ? input.defaultValue : (name === 'zoom' ? 5 : 0);
    };

    const setVal = (name, val) => {
        const key = `node_${nodeId}_${name}`;
        parameters[key] = val;
        const short = name === 'horizontal_angle' ? 'h' : name === 'vertical_angle' ? 'v' : 'z';
        const inputEl = document.getElementById(`input-${nodeId}-${short}`);
        if (inputEl) inputEl.value = val;
    };

    // Make it square
    const width = containerEl.clientWidth || 340;
    const height = width; // Forced square
    containerEl.style.height = `${width}px`;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f172a);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000); // Aspect ratio 1
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    containerEl.appendChild(renderer.domElement);

    const grid = new THREE.GridHelper(10, 10, 0x334155, 0x1e293b);
    scene.add(grid);

    // Subject: Plane instead of Box
    const geometry = new THREE.PlaneGeometry(2, 2);
    const material = new THREE.MeshPhongMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
        transparent: true
    });
    const subject = new THREE.Mesh(geometry, material);
    subject.position.y = 1;
    scene.add(subject);

    // Lights
    const light = new THREE.DirectionalLight(0xffffff, 1);
    light.position.set(5, 10, 7.5);
    scene.add(light);
    scene.add(new THREE.AmbientLight(0x404040));

    // Camera Marker
    const camMarker = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 0.3), new THREE.MeshBasicMaterial({ color: 0xef4444 }));
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.2), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    lens.rotateX(Math.PI/2); lens.position.z = 0.2;
    camMarker.add(body); camMarker.add(lens);
    scene.add(camMarker);

    function updateMarker() {
        const h = parseFloat(getVal('horizontal_angle')) || 0;
        const v = parseFloat(getVal('vertical_angle')) || 0;
        const z = parseFloat(getVal('zoom')) || 5;

        const phi = (90 - v) * (Math.PI / 180);
        const theta = (h + 90) * (Math.PI / 180);
        const radius = 11 - z;

        camMarker.position.set(
            radius * Math.sin(phi) * Math.cos(theta),
            radius * Math.cos(phi) + 1,
            radius * Math.sin(phi) * Math.sin(theta)
        );
        camMarker.lookAt(0, 1, 0);

        camera.position.copy(camMarker.position).multiplyScalar(1.4);
        camera.position.y += 1;
        camera.lookAt(0, 1, 0);
    }

    // Texture logic
    const textureLoader = new THREE.TextureLoader();
    let currentTexturePath = null;

    function findLinkedImageNode() {
        const node = currentWorkflow.workflowApi?.[nodeId];
        if (!node || !node.inputs) return null;

        // Prioritize inputs named "image" or "pixels"
        for (const [name, val] of Object.entries(node.inputs)) {
            if (Array.isArray(val) && (name.toLowerCase().includes('image') || name.toLowerCase().includes('pixels'))) {
                return val[0];
            }
        }

        // Fallback to any linked node
        for (const val of Object.values(node.inputs)) {
            if (Array.isArray(val)) return val[0];
        }
        return null;
    }

    const linkedNodeId = findLinkedImageNode();

    function updateTexture(force = false) {
        if (!linkedNodeId || !window.mediaFiles) return;

        // Try multiple keys for the linked media
        const keys = [
            `media_${linkedNodeId}`,
            `node_${linkedNodeId}_image`,
            `node_${linkedNodeId}_video`,
            `node_${linkedNodeId}_file`
        ];

        let filename = null;
        for (const k of keys) {
            if (window.mediaFiles[k]) {
                filename = window.mediaFiles[k];
                break;
            }
        }

        if (filename && (filename !== currentTexturePath || force)) {
            currentTexturePath = filename;

            // Add cache busting timestamp
            const cacheBuster = force ? `&t=${Date.now()}` : '';
            const textureUrl = `/output/${filename}${filename.includes('?') ? '&' : '?'}${cacheBuster}`;

            textureLoader.load(textureUrl, (txt) => {
                subject.material.map = txt;
                subject.material.needsUpdate = true;
                subject.material.color.set(0xffffff); // Reset color to white so texture shows fully

                if (txt.image) {
                    const aspect = txt.image.width / txt.image.height;
                    subject.scale.set(aspect > 1 ? 1 : aspect, aspect > 1 ? 1/aspect : 1, 1);
                }
            }, undefined, (err) => {
                console.error('Failed to load 3D texture:', textureUrl, err);
            });
        }
    }

    // Register refresh function
    window.qwen3DRefreshRegistry[nodeId] = () => updateTexture(true);

    let isDragging = false;
    let prevMouse = { x: 0, y: 0 };

    const onMouseDown = e => {
        isDragging = true;
        prevMouse = { x: e.clientX, y: e.clientY };
        e.preventDefault();
    };

    const onMouseMove = e => {
        if (!isDragging) return;
        const dx = e.clientX - prevMouse.x;
        const dy = e.clientY - prevMouse.y;

        // INVERTED horizontal orbit: changed - dx to + dx
        let h = (parseFloat(getVal('horizontal_angle')) || 0) + dx;
        let v = (parseFloat(getVal('vertical_angle')) || 0) + dy;

        if (h < 0) h += 360; if (h >= 360) h -= 360;
        v = Math.max(-89, Math.min(89, v)); // Wider range for elevation
        setVal('horizontal_angle', Math.round(h));
        setVal('vertical_angle', Math.round(v));
        updateMarker();
        prevMouse = { x: e.clientX, y: e.clientY };
    };

    const onMouseUp = () => isDragging = false;

    renderer.domElement.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    renderer.domElement.addEventListener('wheel', e => {
        e.preventDefault();
        let z = parseFloat(getVal('zoom')) || 5;
        z = Math.max(0, Math.min(10, z - e.deltaY * 0.01));
        setVal('zoom', parseFloat(z.toFixed(1)));
        updateMarker();
    }, { passive: false });

    function animate() {
        if (!document.getElementById(containerId)) {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
            delete window.qwen3DRefreshRegistry[nodeId];
            renderer.dispose();
            return;
        }
        updateTexture();
        requestAnimationFrame(animate);
        renderer.render(scene, camera);
    }
    updateMarker();
    animate();
};

window.renderQwen3DCard = function(container, nodeId, parameters, currentWorkflow, uiConfig, bypassedNodes, toggleBypassFn) {
    const div = document.createElement('div');
    div.className = 'slate-card p-6 rounded-xl space-y-4 shadow-lg';
    const nodeGroup = currentWorkflow.advancedInputs.find(g => g.nodeId === nodeId);
    const label = nodeGroup ? (uiConfig.inputNames?.[nodeGroup.key] || nodeGroup.title) : '3D Camera Control';
    const isBypassed = bypassedNodes[nodeId];

    div.innerHTML = `
        <div class="flex items-center justify-between mb-2">
            <div class="flex items-center gap-2">
                <label class="block text-sm font-bold text-slate-300 uppercase tracking-wider">${label}</label>
                <button onclick="window.qwen3DRefreshRegistry['${nodeId}']?.()" class="p-1 hover:bg-slate-700 rounded text-blue-400 transition-colors" title="Load/Refresh Image">
                    <i data-lucide="refresh-cw" class="w-3.5 h-3.5"></i>
                </button>
            </div>
            <button id="bypass-btn-${nodeId}" class="text-[10px] font-bold px-2 py-0.5 rounded border border-slate-700 ${isBypassed ? 'bg-red-900/50 text-red-400 border-red-500/50' : 'text-slate-500'}">BYPASS</button>
        </div>
        <div id="qwen-3d-${nodeId}" class="w-full aspect-square bg-slate-900 rounded-lg overflow-hidden border border-slate-700 cursor-move relative ${isBypassed ? 'opacity-30 pointer-events-none' : ''}">
            <div class="absolute bottom-2 left-2 text-[9px] text-slate-500 pointer-events-none bg-slate-950/40 px-2 py-1 rounded tracking-wider uppercase">DRAG TO ROTATE • SCROLL TO ZOOM</div>
        </div>
        <div class="grid grid-cols-3 gap-2 ${isBypassed ? 'opacity-30 pointer-events-none' : ''}">
            <div>
                <label class="block text-[9px] text-slate-500 uppercase mb-1">Azimuth</label>
                <input type="number" id="input-${nodeId}-h" class="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-blue-500">
            </div>
            <div>
                <label class="block text-[9px] text-slate-500 uppercase mb-1">Elevation</label>
                <input type="number" id="input-${nodeId}-v" class="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-blue-500">
            </div>
            <div>
                <label class="block text-[9px] text-slate-500 uppercase mb-1">Zoom</label>
                <input type="number" step="0.1" id="input-${nodeId}-z" class="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-blue-500">
            </div>
        </div>
    `;
    container.appendChild(div);

    // Attach events
    const hIn = div.querySelector(`#input-${nodeId}-h`);
    const vIn = div.querySelector(`#input-${nodeId}-v`);
    const zIn = div.querySelector(`#input-${nodeId}-z`);
    const bpBtn = div.querySelector(`#bypass-btn-${nodeId}`);

    hIn.onchange = (e) => window.updateQwenFromInput(nodeId, 'horizontal_angle', e.target.value, parameters);
    vIn.onchange = (e) => window.updateQwenFromInput(nodeId, 'vertical_angle', e.target.value, parameters);
    zIn.onchange = (e) => window.updateQwenFromInput(nodeId, 'zoom', e.target.value, parameters);
    bpBtn.onclick = () => toggleBypassFn(nodeId);

    if (window.lucide) window.lucide.createIcons();

    setTimeout(() => window.initQwenCamera3D(`qwen-3d-${nodeId}`, nodeId, parameters, currentWorkflow, uiConfig, bypassedNodes), 50);
};

window.updateQwenFromInput = function(nodeId, name, val, parameters) {
    const key = `node_${nodeId}_${name}`;
    parameters[key] = val;
};
