// Independent evaluator: never imports the generated application's own tests.
const assert = require('node:assert/strict');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
(async () => {
  const project = process.argv[2];
  const entry = process.argv[3];
  const scenario = process.argv[4];
  const esbuild = require(path.join(project, 'node_modules/esbuild'));
  const bundle = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' });
  const engine = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  assert.equal(typeof engine.createGame, 'function');
  const game = engine.createGame({ seed: 101, debug: true });
  const initial = game.snapshot();
  assert(Array.isArray(initial.units) && Array.isArray(initial.buildings));
  let evidence = {};
  if (scenario === 'seed_and_tick') {
    const other = engine.createGame({ seed: 101, debug: true });
    assert.deepEqual(other.snapshot(), initial, 'same-seed initial world differs');
    game.step(2);
    assert(game.snapshot().tick > initial.tick, 'tick did not advance');
    assert(game.snapshot().resources.every(r => r.alloy >= 0 && r.energy >= 0));
    evidence = { tick: game.snapshot().tick, initialUnits: initial.units.length };
  } else if (scenario === 'save_load') {
    game.step(2);
    const saved = JSON.parse(JSON.stringify(game.save()));
    const observed = game.snapshot();
    const restored = engine.createGame({ seed: 101, debug: true });
    restored.load(saved);
    assert.deepEqual(restored.snapshot(), observed, 'save/load loses observable state');
    restored.step(2);
    assert(restored.snapshot().tick > observed.tick, 'restored game cannot continue');
    evidence = { restoredTick: restored.snapshot().tick };
  } else if (scenario === 'fog_save') {
    assert.equal(typeof game.getState, 'function', 'full fog introspection not provided: cannot independently verify');
    game.step(2);
    const before = game.getState();
    const fogs = before.fogs.map(f => ({ explored: Array.from(f.explored), visible: Array.from(f.visible) }));
    const saved = JSON.parse(JSON.stringify(game.save()));
    const restored = engine.createGame({ seed: 101, debug: true });
    restored.load(saved);
    assert.deepEqual(restored.getState().fogs.map(f => ({ explored: Array.from(f.explored), visible: Array.from(f.visible) })), fogs, 'fog is not preserved');
    evidence = { fogCells: fogs[0].visible.length };
  } else if (scenario === 'battle_100v100') {
    game.debugScenario({ friendly: 100, enemy: 100 });
    const spawned = game.snapshot();
    assert(spawned.units.filter(u => u.owner === 0).length >= 100);
    assert(spawned.units.filter(u => u.owner === 1).length >= 100);
    const started = performance.now();
    game.step(10);
    const after = game.snapshot();
    assert(after.tick > spawned.tick);
    assert(after.units.every(u => Number.isFinite(u.pos.x) && Number.isFinite(u.pos.y) && u.hp > 0));
    assert.equal(new Set(after.units.map(u => u.id)).size, after.units.length);
    evidence = { unitsBefore: spawned.units.length, unitsAfter: after.units.length, simulationSeconds: 10, wallMilliseconds: Math.round(performance.now() - started) };
  } else throw Error('unknown independent scenario');
  console.log(JSON.stringify({ scenario, evidence }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
