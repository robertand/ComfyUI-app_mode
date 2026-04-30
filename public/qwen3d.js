// Registry to store refresh functions for each 3D instance
window.qwen3DRefreshRegistry = {};

window.initQwenCamera3D = function(containerId, nodeId, parameters, currentWorkflow, uiConfig, bypassedNodes) {
    const containerEl = document.getElementById(containerId);
    if (!containerEl || !window.THREE) return;

    let controlMode = 'orbit'; // 'orbit' or 'manual'

    const getVal = (name) => {
        const key = `node_${nodeId}_${name}`;
        if (parameters[key] !== undefined) return parameters[key];
        const nodeGroup = currentWorkflow.advancedInputs.find(g => g.nodeId === nodeId);
        const input = nodeGroup?.inputs.find(i => i.inputName === name);
        // Default to 0 for angles, 5 for zoom, 35 for focal length (fov equivalent)
        if (input) return input.defaultValue;
        if (name === 'zoom') return 5;
        if (name === 'focal_length') return 35;
        return 0;
    };

    const setVal = (name, val) => {
        const key = `node_${nodeId}_${name}`;
        parameters[key] = val;
        const short = name === 'horizontal_angle' ? 'h' :
                      name === 'vertical_angle' ? 'v' :
                      name === 'zoom' ? 'z' : 'f';
        const inputEl = document.getElementById(`input-${nodeId}-${short}`);
        if (inputEl) inputEl.value = val;
    };

    // Make it square
    const width = containerEl.clientWidth || 340;
    const height = width;
    containerEl.style.height = `${width}px`;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f172a);

    // Initial FOV based on Focal Length (rough approximation: focal 35mm -> FOV ~45deg)
    const initialFocal = parseFloat(getVal('focal_length')) || 35;
    const initialFov = 2 * Math.atan(18 / initialFocal) * (180 / Math.PI); // 18mm is half of 35mm film width

    const camera = new THREE.PerspectiveCamera(initialFov, 1, 0.1, 1000);
    const overviewCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    overviewCamera.position.set(10, 10, 10);
    overviewCamera.lookAt(0, 1.25, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    containerEl.appendChild(renderer.domElement);

    const grid = new THREE.GridHelper(10, 10, 0x334155, 0x1e293b);
    scene.add(grid);

    // Subject: Plane
    const geometry = new THREE.PlaneGeometry(2.5, 2.5);
    const material = new THREE.MeshPhongMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
        transparent: true
    });
    const subject = new THREE.Mesh(geometry, material);
    subject.position.y = 1.25;
    scene.add(subject);

    // Lights
    const light = new THREE.DirectionalLight(0xffffff, 1.2);
    light.position.set(5, 10, 7.5);
    scene.add(light);
    scene.add(new THREE.AmbientLight(0x606060));

    // Camera Marker
    const camMarker = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 0.3), new THREE.MeshBasicMaterial({ color: 0xef4444 }));
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.2), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    lens.rotateX(Math.PI/2); lens.position.z = 0.2;
    camMarker.add(body); camMarker.add(lens);
    scene.add(camMarker);

    // --- SPECIALIZED HANDLES ---
    const handleGroup = new THREE.Group();
    scene.add(handleGroup);

    // 1. Azimuth Ring (Pink)
    const ringGeo = new THREE.TorusGeometry(3.5, 0.05, 8, 100);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xff00ff, transparent: true, opacity: 0.6 });
    const azimuthRing = new THREE.Mesh(ringGeo, ringMat);
    azimuthRing.rotation.x = Math.PI / 2;
    azimuthRing.position.y = 1.25;
    handleGroup.add(azimuthRing);

    // 2. Elevation Arc (Cyan) - Will be updated dynamically
    const arcMat = new THREE.MeshBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.6, side: THREE.DoubleSide });
    let elevationArc = new THREE.Mesh(new THREE.BufferGeometry(), arcMat);
    handleGroup.add(elevationArc);

    // 3. Zoom Line (Gold)
    const zoomLineGeo = new THREE.CylinderGeometry(0.03, 0.03, 10);
    const zoomLineMat = new THREE.MeshBasicMaterial({ color: 0xffd700, transparent: true, opacity: 0.4 });
    const zoomLine = new THREE.Mesh(zoomLineGeo, zoomLineMat);
    zoomLine.position.y = 1.25;
    handleGroup.add(zoomLine);

    // Drag indicators (Small spheres on handles)
    const sphereGeo = new THREE.SphereGeometry(0.15, 16, 16);
    const hIndicator = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ color: 0xff00ff }));
    const vIndicator = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ color: 0x00ffff }));
    const zIndicator = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ color: 0xffd700 }));
    handleGroup.add(hIndicator, vIndicator, zIndicator);

    function updateHandles() {
        const h = parseFloat(getVal('horizontal_angle')) || 0;
        const v = parseFloat(getVal('vertical_angle')) || 0;
        const z = parseFloat(getVal('zoom')) || 5;
        const radius = 11 - z;

        const phi = (90 - v) * (Math.PI / 180);
        const theta = (-h + 90) * (Math.PI / 180);

        // Update indicators
        hIndicator.position.set(3.5 * Math.cos(theta), 1.25, 3.5 * Math.sin(theta));
        vIndicator.position.set(radius * Math.sin(phi) * Math.cos(theta), radius * Math.cos(phi) + 1.25, radius * Math.sin(phi) * Math.sin(theta));
        zIndicator.position.copy(vIndicator.position);

        // Update Elevation Arc
        handleGroup.remove(elevationArc);
        const arcGeo = new THREE.TorusGeometry(radius, 0.02, 8, 50, (120 * Math.PI / 180));
        elevationArc = new THREE.Mesh(arcGeo, arcMat);
        elevationArc.position.y = 1.25;
        elevationArc.rotation.y = theta;
        elevationArc.rotation.z = Math.PI / 2 + (30 * Math.PI / 180);
        handleGroup.add(elevationArc);

        // Update Zoom Line Orientation
        zoomLine.lookAt(vIndicator.position.x, vIndicator.position.y, vIndicator.position.z);
        zoomLine.rotateX(Math.PI/2);
        zoomLine.position.set(vIndicator.position.x/2, (vIndicator.position.y + 1.25)/2, vIndicator.position.z/2);
        zoomLine.scale.y = radius / 10;
    }

    function updateCamera() {
        if (controlMode === 'orbit') {
            camera.position.copy(camMarker.position).multiplyScalar(1.4);
            camera.position.y += 1;
            camera.lookAt(0, 1.25, 0);
        }
    }

    function updateMarker() {
        const h = parseFloat(getVal('horizontal_angle')) || 0;
        const v = parseFloat(getVal('vertical_angle')) || 0;
        const z = parseFloat(getVal('zoom')) || 5;
        const focal = parseFloat(getVal('focal_length')) || 35;

        // Update FOV
        camera.fov = 2 * Math.atan(18 / focal) * (180 / Math.PI);
        camera.updateProjectionMatrix();

        const phi = (90 - v) * (Math.PI / 180);
        const theta = (-h + 90) * (Math.PI / 180);
        const radius = 11 - z;

        camMarker.position.set(
            radius * Math.sin(phi) * Math.cos(theta),
            radius * Math.cos(phi) + 1.25,
            radius * Math.sin(phi) * Math.sin(theta)
        );
        camMarker.lookAt(0, 1.25, 0);
        updateCamera();
    }

    // Texture logic
    const textureLoader = new THREE.TextureLoader();
    let currentTexturePath = null;

    function findLinkedImageNode() {
        const api = currentWorkflow.workflowApi || (currentWorkflow.raw && currentWorkflow.raw.workflow);
        const node = api ? api[nodeId] : null;
        if (!node || !node.inputs) return null;
        for (const [name, val] of Object.entries(node.inputs)) {
            if (Array.isArray(val) && (name.toLowerCase().includes('image') || name.toLowerCase().includes('pixels'))) {
                return val[0];
            }
        }
        for (const val of Object.values(node.inputs)) {
            if (Array.isArray(val)) return val[0];
        }
        return null;
    }

    const linkedNodeId = findLinkedImageNode();

    function updateTexture(force = false) {
        if (!linkedNodeId || !window.mediaFiles) return;
        const filename = window.mediaFiles[`media_${linkedNodeId}`] ||
                         window.mediaFiles[`node_${linkedNodeId}_image`] ||
                         window.mediaFiles[`node_${linkedNodeId}_file`] ||
                         window.mediaFiles[`node_${linkedNodeId}_pixels`];

        if (filename && (filename !== currentTexturePath || force)) {
            currentTexturePath = filename;
            const textureUrl = `/output/${filename}${filename.includes('?') ? '&' : '?'}${force ? 't=' + Date.now() : ''}`;
            textureLoader.load(textureUrl, (txt) => {
                subject.material.map = txt;
                subject.material.needsUpdate = true;
                subject.material.color.set(0xffffff);
                if (txt.image) {
                    const aspect = txt.image.width / txt.image.height;
                    subject.scale.set(aspect > 1 ? 1 : aspect, aspect > 1 ? 1/aspect : 1, 1);
                }
            });
        }
    }

    window.qwen3DRefreshRegistry[nodeId] = () => updateTexture(true);

    let isDragging = false;
    let prevMouse = { x: 0, y: 0 };

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let activeHandle = null;

    const onMouseDown = e => {
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

        if (controlMode === 'manual') {
            raycaster.setFromCamera(mouse, overviewCamera);
            const intersects = raycaster.intersectObjects([hIndicator, vIndicator, zIndicator]);
            if (intersects.length > 0) {
                activeHandle = intersects[0].object;
                isDragging = true;
                e.preventDefault();
                return;
            }
        }

        if (controlMode === 'orbit') {
            isDragging = true;
            prevMouse = { x: e.clientX, y: e.clientY };
            e.preventDefault();
        }
    };

    const onMouseMove = e => {
        if (!isDragging) return;

        if (controlMode === 'manual' && activeHandle) {
            const rect = renderer.domElement.getBoundingClientRect();
            mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

            raycaster.setFromCamera(mouse, overviewCamera);
            const planeNormal = new THREE.Vector3(0, 1, 0);
            const plane = new THREE.Plane(planeNormal, -1.25);
            const intersectPoint = new THREE.Vector3();

            if (activeHandle === hIndicator) {
                if (raycaster.ray.intersectPlane(plane, intersectPoint)) {
                    const angle = Math.atan2(intersectPoint.z, intersectPoint.x);
                    let h = 90 - (angle * 180 / Math.PI);
                    setVal('horizontal_angle', Math.round(((h % 360) + 360) % 360));
                }
            } else if (activeHandle === vIndicator || activeHandle === zIndicator) {
                // Simplified handle drag for vertical and zoom
                const dx = e.clientX - prevMouse.x;
                const dy = e.clientY - prevMouse.y;
                if (activeHandle === vIndicator) {
                    let v = (parseFloat(getVal('vertical_angle')) || 0) + dy;
                    setVal('vertical_angle', Math.round(Math.max(-30, Math.min(90, v))));
                } else {
                    let z = parseFloat(getVal('zoom')) || 5;
                    z = Math.max(0, Math.min(10, z - dy * 0.1));
                    setVal('zoom', parseFloat(z.toFixed(1)));
                }
            }
            updateMarker();
            updateHandles();
            prevMouse = { x: e.clientX, y: e.clientY };
            return;
        }

        if (controlMode === 'orbit') {
            const dx = e.clientX - prevMouse.x;
            const dy = e.clientY - prevMouse.y;
            let h = (parseFloat(getVal('horizontal_angle')) || 0) - dx;
            let v = (parseFloat(getVal('vertical_angle')) || 0) + dy;
            if (h < 0) h += 360; if (h >= 360) h -= 360;
            v = Math.max(-89, Math.min(89, v));
            setVal('horizontal_angle', Math.round(h));
            setVal('vertical_angle', Math.round(v));
            updateMarker();
            updateHandles();
            prevMouse = { x: e.clientX, y: e.clientY };
        }
    };

    const onMouseUp = () => { isDragging = false; activeHandle = null; };

    renderer.domElement.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    renderer.domElement.addEventListener('wheel', e => {
        if (controlMode !== 'orbit') return;
        e.preventDefault();
        let z = parseFloat(getVal('zoom')) || 5;
        z = Math.max(0, Math.min(10, z - e.deltaY * 0.01));
        setVal('zoom', parseFloat(z.toFixed(1)));
        updateMarker();
    }, { passive: false });

    // Mode Toggle Logic
    const orbitBtn = document.getElementById(`btn-${nodeId}-orbit`);
    const manualBtn = document.getElementById(`btn-${nodeId}-manual`);

    const setMode = (mode) => {
        controlMode = mode;
        if (mode === 'orbit') {
            orbitBtn.classList.add('bg-blue-600', 'text-white');
            orbitBtn.classList.remove('bg-slate-800', 'text-slate-400');
            manualBtn.classList.add('bg-slate-800', 'text-slate-400');
            manualBtn.classList.remove('bg-blue-600', 'text-white');
            handleGroup.visible = false;
            camMarker.visible = false;
            renderer.domElement.style.cursor = 'move';
        } else {
            manualBtn.classList.add('bg-blue-600', 'text-white');
            manualBtn.classList.remove('bg-slate-800', 'text-slate-400');
            orbitBtn.classList.add('bg-slate-800', 'text-slate-400');
            orbitBtn.classList.remove('bg-blue-600', 'text-white');
            handleGroup.visible = true;
            camMarker.visible = true;
            updateHandles();
            renderer.domElement.style.cursor = 'default';
        }
    };

    if (orbitBtn) orbitBtn.onclick = () => setMode('orbit');
    if (manualBtn) manualBtn.onclick = () => setMode('manual');

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
        renderer.render(scene, controlMode === 'orbit' ? camera : overviewCamera);
    }
    updateMarker();
    updateHandles();
    setMode('orbit'); // Initialize mode
    animate();
};

window.renderQwen3DCard = function(container, nodeId, parameters, currentWorkflow, uiConfig, bypassedNodes, toggleBypassFn) {
    const div = document.createElement('div');
    div.className = 'slate-card p-6 rounded-xl space-y-4 shadow-lg';
    const nodeGroup = currentWorkflow.advancedInputs.find(g => g.nodeId === nodeId);
    const label = nodeGroup ? (uiConfig.inputNames?.[nodeGroup.key] || nodeGroup.title) : '3D Camera Control';
    const isBypassed = bypassedNodes[nodeId];

    // Ensure defaults for new workflows if not set
    if (parameters[`node_${nodeId}_horizontal_angle`] === undefined) parameters[`node_${nodeId}_horizontal_angle`] = 0;
    if (parameters[`node_${nodeId}_vertical_angle`] === undefined) parameters[`node_${nodeId}_vertical_angle`] = 0;
    if (parameters[`node_${nodeId}_zoom`] === undefined) parameters[`node_${nodeId}_zoom`] = 5;
    if (parameters[`node_${nodeId}_focal_length`] === undefined) parameters[`node_${nodeId}_focal_length`] = 35;

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

        <div class="flex gap-2 mb-2 ${isBypassed ? 'opacity-30 pointer-events-none' : ''}">
            <button id="btn-${nodeId}-orbit" class="flex-1 py-1.5 px-3 rounded bg-blue-600 text-white text-[10px] font-bold transition-all shadow-sm flex items-center justify-center gap-1.5 uppercase tracking-wider">
                <i data-lucide="camera" class="w-3.5 h-3.5"></i>
                <span>Camera View</span>
            </button>
            <button id="btn-${nodeId}-manual" class="flex-1 py-1.5 px-3 rounded bg-slate-800 text-slate-400 text-[10px] font-bold transition-all shadow-sm flex items-center justify-center gap-1.5 uppercase tracking-wider">
                <i data-lucide="settings-2" class="w-3.5 h-3.5"></i>
                <span>Manual Controls</span>
            </button>
        </div>

        <div id="qwen-3d-${nodeId}" class="w-full aspect-square bg-slate-900 rounded-lg overflow-hidden border border-slate-700 cursor-move relative ${isBypassed ? 'opacity-30 pointer-events-none' : ''}">
            <div class="absolute bottom-2 left-2 text-[9px] text-slate-500 pointer-events-none bg-slate-950/40 px-2 py-1 rounded tracking-wider uppercase">DRAG TO ROTATE • SCROLL TO ZOOM</div>
        </div>
        <div class="grid grid-cols-2 gap-4 ${isBypassed ? 'opacity-30 pointer-events-none' : ''}">
            <div class="space-y-2">
                <div>
                    <label class="block text-[9px] text-slate-500 uppercase mb-1">Azimuth</label>
                    <input type="number" id="input-${nodeId}-h" value="0" class="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-blue-500">
                </div>
                <div>
                    <label class="block text-[9px] text-slate-500 uppercase mb-1">Elevation</label>
                    <input type="number" id="input-${nodeId}-v" value="0" class="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-blue-500">
                </div>
            </div>
            <div class="space-y-2">
                <div>
                    <label class="block text-[9px] text-slate-500 uppercase mb-1">Zoom (Distance)</label>
                    <input type="number" step="0.1" id="input-${nodeId}-z" value="5" class="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-blue-500">
                </div>
                <div>
                    <label class="block text-[9px] text-slate-500 uppercase mb-1">Focal Length (mm)</label>
                    <input type="number" id="input-${nodeId}-f" value="35" class="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-blue-500">
                </div>
            </div>
        </div>
    `;
    container.appendChild(div);

    const hIn = div.querySelector(`#input-${nodeId}-h`);
    const vIn = div.querySelector(`#input-${nodeId}-v`);
    const zIn = div.querySelector(`#input-${nodeId}-z`);
    const fIn = div.querySelector(`#input-${nodeId}-f`);
    const bpBtn = div.querySelector(`#bypass-btn-${nodeId}`);

    hIn.onchange = (e) => window.updateQwenFromInput(nodeId, 'horizontal_angle', e.target.value, parameters);
    vIn.onchange = (e) => window.updateQwenFromInput(nodeId, 'vertical_angle', e.target.value, parameters);
    zIn.onchange = (e) => window.updateQwenFromInput(nodeId, 'zoom', e.target.value, parameters);
    fIn.onchange = (e) => window.updateQwenFromInput(nodeId, 'focal_length', e.target.value, parameters);
    bpBtn.onclick = () => toggleBypassFn(nodeId);

    if (window.lucide) window.lucide.createIcons();

    setTimeout(() => window.initQwenCamera3D(`qwen-3d-${nodeId}`, nodeId, parameters, currentWorkflow, uiConfig, bypassedNodes), 50);
};

window.updateQwenFromInput = function(nodeId, name, val, parameters) {
    const key = `node_${nodeId}_${name}`;
    parameters[key] = val;
    // Trigger update in THREE.js if instance exists
    if (window.qwen3DRefreshRegistry[nodeId]) {
        // We don't need a full force refresh here, updateMarker will be called in animate loop
    }
};
