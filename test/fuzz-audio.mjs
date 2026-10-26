// Fuzzer for the audio path behind the core: random and mutated CTerm audio
// APC strings, CSI = 7 requests and "ANSI" music, through the real core and
// the real engine (Node harness). Checks that nothing throws, the engine's
// command chain never fails, and the limits hold.
//
//   node test/fuzz-audio.mjs [seconds=20] [seed]
import { pathToFileURL } from 'node:url';
import { rng, audioApc, music } from './fuzz-core.mjs';
import { NodeTerm, wav } from './audio-harness.mjs';

const ESC = String.fromCharCode(27);

export async function fuzzAudio({ seconds = 20, seed = 1, cases = Infinity, log = () => {} } = {}) {
    const end = Date.now() + seconds * 1000;
    const failures = [];
    let done = 0;
    let node = new NodeTerm({ holdCap: 20 });
    const good = Buffer.from(wav(0.02)).toString('base64');
    for (; done < cases && Date.now() < end; done++) {
        const r = rng((seed + done * 0x9e3779b1) >>> 0);
        const parts = [];
        // Some files the commands can find.
        if (r.next() < 0.3) parts.push(`${ESC}_SyncTERM:C;S;${r.pick(['a', 'sfx/a', 'sfx/hit'])};${good}${ESC}\\`);
        for (let i = 0, n = 1 + r.int(30); i < n; i++) parts.push(r.next() < 0.8 ? audioApc(r) : music(r));
        try {
            for (const p of parts) node.socket.write(Buffer.from(p, 'latin1'));
            await Promise.race([node.pending, new Promise((_, j) => setTimeout(() => j(new Error('stuck')), 5000))]);
            const items = node.engine.mixer.allItems().length;
            if (items > 128) throw new Error(`${items} items`);
            if (node.engine.stats.errors) throw new Error(`engine errors: ${node.logs.filter(l => l.startsWith('audio: error')).join('; ')}`);
        } catch (e) {
            failures.push({ seed: done, message: String(e), parts });
            log(`FAIL case ${done}: ${e}`);
            node.destroy();
            node = new NodeTerm({ holdCap: 20 });
        }
        if (done % 40 === 39) {
            node.destroy();
            node = new NodeTerm({ holdCap: 20 });
        }
    }
    node.destroy();
    return { cases: done, failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const seconds = Number(process.argv[2] ?? 20);
    const seed = process.argv[3] !== undefined ? Number(process.argv[3]) : (Date.now() & 0xffffffff) >>> 0;
    console.log(`fuzz-audio: ${seconds}s, seed ${seed}`);
    const res = await fuzzAudio({ seconds, seed, log: m => console.log(m) });
    console.log(`fuzz-audio: ${res.cases} cases, ${res.failures.length} failures`);
    for (const f of res.failures.slice(0, 5)) console.log(`  ${f.message}\n    ${JSON.stringify(f.parts).slice(0, 400)}`);
    process.exit(res.failures.length ? 1 : 0);
}
