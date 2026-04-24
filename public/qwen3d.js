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

    const width = containerEl.clientWidth || 340;
    const height = 220;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f172a);
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    containerEl.appendChild(renderer.domElement);

    const grid = new THREE.GridHelper(10, 10, 0x334155, 0x1e293b);
    scene.add(grid);

    // Simple Subject
    const geometry = new THREE.BoxGeometry(1, 1.6, 0.5);
    const material = new THREE.MeshPhongMaterial({ color: 0x3b82f6 });
    const subject = new THREE.Mesh(geometry, material);
    subject.position.y = 0.8;
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
            radius * Math.cos(phi) + 0.8,
            radius * Math.sin(phi) * Math.sin(theta)
        );
        camMarker.lookAt(0, 0.8, 0);

        camera.position.copy(camMarker.position).multiplyScalar(1.4);
        camera.position.y += 1;
        camera.lookAt(0, 0.8, 0);
    }

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
        let h = (parseFloat(getVal('horizontal_angle')) || 0) - dx;
        let v = (parseFloat(getVal('vertical_angle')) || 0) + dy;
        if (h < 0) h += 360; if (h >= 360) h -= 360;
        v = Math.max(-30, Math.min(60, v));
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
            renderer.dispose();
            return;
        }
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
            <label class="block text-sm font-bold text-slate-300 uppercase tracking-wider">${label}</label>
            <button id="bypass-btn-${nodeId}" class="text-[10px] font-bold px-2 py-0.5 rounded border border-slate-700 ${isBypassed ? 'bg-red-900/50 text-red-400 border-red-500/50' : 'text-slate-500'}">BYPASS</button>
        </div>
        <div id="qwen-3d-${nodeId}" class="w-full h-[220px] bg-slate-900 rounded-lg overflow-hidden border border-slate-700 cursor-move relative ${isBypassed ? 'opacity-30 pointer-events-none' : ''}">
            <div class="absolute bottom-2 left-2 text-[9px] text-slate-500 pointer-events-none bg-slate-950/40 px-2 py-1 rounded tracking-wider">DRAG TO ROTATE • SCROLL TO ZOOM</div>
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

    setTimeout(() => window.initQwenCamera3D(`qwen-3d-${nodeId}`, nodeId, parameters, currentWorkflow, uiConfig, bypassedNodes), 50);
};

window.updateQwenFromInput = function(nodeId, name, val, parameters) {
    const key = `node_${nodeId}_${name}`;
    parameters[key] = val;
};
