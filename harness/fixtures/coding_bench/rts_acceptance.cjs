// Independent evaluator: never imports the generated application's own tests.
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
(async () => {
  const scenario = process.argv[4];
  const seed = Number(process.argv[5] || 101);
  const engine = __engineBridge;
  const game = await engine.createGame({ seed, debug: true });
  const observe = async () => structuredClone(await game.snapshot());
  const initial = await observe();
  assert(Array.isArray(initial.units) && Array.isArray(initial.buildings));
  const position = unit => unit.position || unit.pos;
  const queueSize = state => Array.isArray(state.pathQueue) ? state.pathQueue.length : state.pathQueue;
  const validUnits = async state => {
    const stateDetails = typeof game.getState === 'function' ? await game.getState() : {};
    const resources = stateDetails.resourceNodes || stateDetails.map?.resources || [];
    const validTargets = new Set([...state.units, ...state.buildings, ...resources].map(item => item.id));
    assert.equal(new Set(state.units.map(unit => unit.id)).size, state.units.length, 'duplicate unit IDs');
    for (const unit of state.units) {
      const p = position(unit);
      assert(p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(unit.hp) && unit.hp > 0, 'invalid live unit');
    }
    for (const unit of state.units) if (unit.target && typeof unit.target === 'string') {
      assert(validTargets.has(unit.target), 'dangling target reference');
    }
  };
  let evidence = {seed};
  if (scenario === 'seed_and_tick') {
    const other = await engine.createGame({ seed, debug: true });
    assert.deepEqual(await other.snapshot(), initial, 'same-seed initial world differs');
    await game.step(2);
    assert((await observe()).tick > initial.tick, 'tick did not advance');
    assert((await observe()).resources.every(r => r.alloy >= 0 && r.energy >= 0));
    evidence = { tick: (await observe()).tick, initialUnits: initial.units.length };
  } else if (scenario === 'save_load') {
    await game.step(2);
    const saved = JSON.parse(JSON.stringify(await game.save()));
    const observed = await observe();
    const restored = await engine.createGame({ seed, debug: true });
    await restored.load(saved);
    assert.deepEqual(await restored.snapshot(), observed, 'save/load loses observable state');
    await restored.step(2);
    assert((await restored.snapshot()).tick > observed.tick, 'restored game cannot continue');
    evidence = { restoredTick: (await restored.snapshot()).tick };
  } else if (scenario === 'fog_save') {
    assert.equal(typeof game.getState, 'function', 'full fog introspection not provided: cannot independently verify');
    await game.step(2);
    const before = await game.getState();
    const fogs = before.fogs.map(f => ({ explored: Array.from(f.explored), visible: Array.from(f.visible) }));
    const saved = JSON.parse(JSON.stringify(await game.save()));
    const restored = await engine.createGame({ seed, debug: true });
    await restored.load(saved);
    assert.deepEqual((await restored.getState()).fogs.map(f => ({ explored: Array.from(f.explored), visible: Array.from(f.visible) })), fogs, 'fog is not preserved');
    evidence = { fogCells: fogs[0].visible.length };
  } else if (scenario === 'battle_100v100') {
    await game.debugScenario({ friendly: 100, enemy: 100 });
    const spawned = await observe();
    assert(spawned.units.filter(u => u.owner === 0).length >= 100);
    assert(spawned.units.filter(u => u.owner === 1).length >= 100);
    const started = performance.now();
    const enemy = spawned.units.find(unit => unit.owner === 1);
    await game.command({type: 'attackMove', unitIds: spawned.units.filter(unit => unit.owner === 0).map(unit => unit.id), target: position(enemy)});
    const friendly = spawned.units.find(unit => unit.owner === 0);
    await game.command({type: 'attackMove', unitIds: spawned.units.filter(unit => unit.owner === 1).map(unit => unit.id), target: position(friendly)});
    await game.step(60);
    const wallMilliseconds = Math.round(performance.now() - started);
    const after = await observe();
    const totalHpBefore = spawned.units.reduce((sum, unit) => sum + unit.hp, 0);
    const totalHpAfter = after.units.reduce((sum, unit) => sum + unit.hp, 0);
    assert(totalHpAfter < totalHpBefore || after.units.length < spawned.units.length, '100v100 units never actually fought');
    assert(wallMilliseconds < 8000, '60-second battle simulation exceeds independent performance budget');
    assert(after.tick > spawned.tick);
    await validUnits(after);
    assert.equal(new Set(after.units.map(u => u.id)).size, after.units.length);
    evidence = { unitsBefore: spawned.units.length, unitsAfter: after.units.length, simulationSeconds: 60, wallMilliseconds };
  } else if (scenario === 'movement_200') {
    await game.debugScenario({friendly: 200, enemy: 0});
    const spawned = await observe();
    const units = spawned.units.filter(unit => unit.owner === 0);
    assert(units.length >= 200, '200-unit movement setup is missing');
    const origins = new Map(units.map(unit => [unit.id, position(unit)]));
    await game.command({type: 'move', unitIds: units.map(unit => unit.id), target: {x: 110, y: 110}});
    const started = performance.now();
    await game.step(30);
    const wallMilliseconds = Math.round(performance.now() - started);
    const after = await observe();
    await validUnits(after);
    assert(after.units.filter(unit => origins.has(unit.id) && Math.hypot(position(unit).x - origins.get(unit.id).x, position(unit).y - origins.get(unit.id).y) > 1).length >= 180, 'mass move failed to progress for at least 90% of units');
    assert(queueSize(after) >= 0 && queueSize(after) <= after.units.length, 'path queue grows beyond one pending request per unit');
    assert(wallMilliseconds < 5000, 'mass movement freezes simulation');
    evidence = {seed, units: after.units.length, pathQueue: queueSize(after), wallMilliseconds};
  } else if (scenario === 'continuation_determinism') {
    await game.step(7.5);
    const restored = await engine.createGame({seed, debug: true});
    await restored.load(JSON.parse(JSON.stringify(await game.save())));
    const command = {type: 'move', unitIds: (await observe()).units.filter(unit => unit.owner === 0).map(unit => unit.id), target: {x: 70, y: 65}};
    await game.command(command); await restored.command(command);
    await game.step(20); await restored.step(20);
    assert.deepEqual(await restored.snapshot(), await observe(), 'saved RNG/AI/queues do not produce deterministic continuation');
    evidence = {seed, tick: (await observe()).tick};
  } else if (scenario === 'long_run_cleanup') {
    await game.debugScenario({friendly:100, enemy:100});
    for (let i=0; i<30; i++) {
      await game.step(10);
      const state = await observe();
      await validUnits(state);
      assert(queueSize(state) <= Math.max(1, state.units.length), 'unbounded stale path requests');
      assert(state.projectiles && state.projectiles.length <= 2000, 'missing or unbounded projectile lifecycle');
    }
    evidence = {seed, simulationSeconds:300, units:(await observe()).units.length};
  } else throw Error('unknown independent scenario');
  console.log(JSON.stringify({ scenario, seed, evidence }));
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => __engineBridge.close());
