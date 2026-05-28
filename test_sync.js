const fs = require('fs');
const path = require('path');

// Mock fetch
global.fetch = async (url) => {
    console.log('Mock fetch to:', url);
    return {
        ok: true,
        buffer: async () => Buffer.from('console.log("pixaroma asset")')
    };
};

// Mock getFreestInstance
const getFreestInstance = async () => 'http://127.0.0.1:8188';

async function testSync() {
    const baseExtDir = path.join(__dirname, 'extensions', 'ComfyUI-Pixaroma');
    if (fs.existsSync(baseExtDir)) {
        fs.rmSync(baseExtDir, { recursive: true, force: true });
    }
    fs.mkdirSync(baseExtDir, { recursive: true });

    const variants = ['ComfyUI-Pixaroma'];
    const folders = ['3d', 'paint'];

    for (const f of folders) {
        const subDir = path.join(baseExtDir, 'js', f);
        if (!fs.existsSync(subDir)) fs.mkdirSync(subDir, { recursive: true });

        const p = `/extensions/${variants[0]}/js/${f}/index.js`;
        const target = await getFreestInstance();
        const response = await fetch(`${target}${p}`);
        if (response.ok) {
            const buffer = await response.buffer();
            fs.writeFileSync(path.join(subDir, 'index.js'), buffer);
            console.log(`[Test] Downloaded ${f}/index.js`);
        }
    }

    const exists = fs.existsSync(path.join(baseExtDir, 'js', '3d', 'index.js'));
    console.log('3d/index.js exists:', exists);
    if (!exists) process.exit(1);
}

testSync().catch(e => { console.error(e); process.exit(1); });
