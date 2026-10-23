import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { EventEmitter } from 'node:events';

class TestWorker extends EventEmitter { postMessage() {} }
mock.module('worker_threads', () => ({ Worker: TestWorker }));
await import('../../src/engine/World.js');
const { default: InvType } = await import('../../src/cache/config/InvType.js');
const { default: ObjType } = await import('../../src/cache/config/ObjType.js');
const { default: VarPlayerType } = await import('../../src/cache/config/VarPlayerType.js');
const { default: Player, getExpByLevel } = await import('../../src/engine/entity/Player.js');
const { PlayerLoading } = await import('../../src/engine/entity/PlayerLoading.js');
const { PlayerStat } = await import('../../src/engine/entity/PlayerStat.js');
const { default: Packet } = await import('../../src/io/Packet.js');
const { createTables, joinFamily, leaveFamily, saveFamilies } = await import('../../src/engine/Clones.js');
InvType.load(process.env.BANK_TEST_CACHE!);
ObjType.load(process.env.BANK_TEST_CACHE!);
VarPlayerType.load(process.env.BANK_TEST_CACHE!);

const BANK = InvType.getId('bank');
const COINS = ObjType.getId('coins');
const LOGS = ObjType.getId('logs');
const database = new Database(process.env.CLONES_DATABASE!);
createTables(database);
database.query('INSERT INTO clone VALUES (?, ?)').run('kimmoc1', 'kimmo');
database.query('INSERT INTO clone VALUES (?, ?)').run('kimmoc2', 'kimmo');

const load = (name: string, save = new Uint8Array()) => PlayerLoading.load(name, new Packet(save), null);
const reload = (player: InstanceType<typeof Player>) => load(player.username, player.save(false));

// A clone can't play before its main has started the family.
const early = load('kimmoc1');
assert.match(joinFamily(early)!, /log in as kimmo once first/);
assert.equal(early.family, null);

// The main starts the family with their own XP and bank. Total 28 + 98 = 126: one clone.
const main = load('kimmo');
main.addXp(PlayerStat.WOODCUTTING, getExpByLevel(99), false);
main.getInventory(BANK)!.add(COINS, 1000);
assert.equal(joinFamily(main), null);
assert.equal(main.family, 'kimmo');

// Clone 1 gets the family's levels and the very same bank.
const clone = load('kimmoc1');
assert.equal(joinFamily(clone), null);
assert.equal(clone.isClone, true);
assert.equal(clone.baseLevels[PlayerStat.WOODCUTTING], 99);
assert.equal(clone.getInventory(BANK), main.getInventory(BANK));

// Clone 2 needs total level 200.
assert.match(joinFamily(load('kimmoc2'))!, /unlocks at total level 200 \(now 126\)/);

// XP either one gains goes to both.
clone.addXp(PlayerStat.FISHING, getExpByLevel(40), false);
assert.equal(main.baseLevels[PlayerStat.FISHING], 40);
main.addXp(PlayerStat.MINING, getExpByLevel(30), false);
assert.equal(clone.baseLevels[PlayerStat.MINING], 30);

// A clone deposits; its own save leaves the shared bank out.
clone.getInventory(BANK)!.add(LOGS, 5);
assert.equal(reload(clone).getInventory(BANK)!.itemsFiltered.length, 0);

// The main logs out with an older bank copy in its save, the clone keeps playing.
const mainSave = main.save(false);
leaveFamily(main);
clone.addXp(PlayerStat.COOKING, getExpByLevel(20), false);
saveFamilies();
leaveFamily(clone);

// Next login, the main gets the family bank and the XP earned while away.
const back = load('kimmo', mainSave);
assert.equal(joinFamily(back), null);
assert.equal(back.getInventory(BANK)!.itemsFiltered.find(i => i.id === LOGS)?.count, 5);
assert.equal(back.baseLevels[PlayerStat.COOKING], 20);

// Total is now 28 + 98 + 39 + 29 + 19 = 213, so clone 2 unlocks.
const second = load('kimmoc2');
assert.equal(joinFamily(second), null);
assert.equal(second.baseLevels[PlayerStat.COOKING], 20);

const row = database.query('SELECT total FROM family WHERE main=?').get('kimmo') as { total: number };
assert.equal(row.total, 213);
console.log('Clone checks passed');
database.close();
process.exit(0);
