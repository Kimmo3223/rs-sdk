import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { EventEmitter } from 'node:events';

class TestWorker extends EventEmitter { postMessage() {} }
mock.module('worker_threads', () => ({ Worker: TestWorker }));
await import('../../src/engine/World.js');
const { default: InvType } = await import('../../src/cache/config/InvType.js');
const { default: ObjType } = await import('../../src/cache/config/ObjType.js');
const { default: VarPlayerType } = await import('../../src/cache/config/VarPlayerType.js');
const { PlayerLoading } = await import('../../src/engine/entity/PlayerLoading.js');
const { default: Packet } = await import('../../src/io/Packet.js');
const { Visibility } = await import('../../src/network/rsbuf/index.js');
const { startSpectating, stopSpectating, followTarget } = await import('../../src/engine/Spectate.js');
InvType.load(process.env.BANK_TEST_CACHE!);
ObjType.load(process.env.BANK_TEST_CACHE!);
VarPlayerType.load(process.env.BANK_TEST_CACHE!);

const load = (name: string, x: number, z: number) => {
    const player = PlayerLoading.load(name, new Packet(new Uint8Array()), null);
    player.x = x;
    player.z = z;
    player.isActive = true;
    // No map in this fixture: staff level 3 lets teleports skip the zone check.
    player.staffModLevel = 3;
    return player;
};
const watcher = load('watcher', 3222, 3218);
const target = load('target', 3165, 3485);
const others = new Map([['watcher', watcher], ['target', target]]);
const find = (name: string) => others.get(name);
const online = new Set([target]);

assert.equal(startSpectating(watcher, 'nobody', find), 'nobody is not logged in.');
assert.equal(startSpectating(watcher, 'watcher', find), "You can't watch yourself.");

// Watching: invisible, standing on the target, but saved where they started.
assert.match(startSpectating(watcher, 'target', find), /Watching Target/);
assert.equal(watcher.spectating, target);
assert.equal(watcher.visibility, Visibility.HARD);
assert.deepEqual([watcher.x, watcher.z], [3165, 3485]);
const saved = PlayerLoading.load('watcher', new Packet(watcher.save(false)), null);
assert.deepEqual([saved.x, saved.z], [3222, 3218]);

// The target can't be watched-through, and the spectator keeps up.
assert.match(startSpectating(target, 'watcher', find), /is not logged in|watching someone else/);
target.x += 2;
followTarget(watcher, t => online.has(t));
assert.equal(watcher.tempRun, 1);
target.x += 50;
followTarget(watcher, t => online.has(t));
assert.deepEqual([watcher.x, watcher.z], [target.x, target.z]);

// The target logs out: the spectator goes home, visible again.
online.delete(target);
followTarget(watcher, t => online.has(t));
assert.equal(watcher.spectating, null);
assert.equal(watcher.visibility, Visibility.DEFAULT);
assert.deepEqual([watcher.x, watcher.z], [3222, 3218]);

// Stopping by hand does the same.
online.add(target);
startSpectating(watcher, 'target', find);
stopSpectating(watcher);
assert.deepEqual([watcher.x, watcher.z, watcher.spectating], [3222, 3218, null]);
console.log('Spectate checks passed');
process.exit(0);
