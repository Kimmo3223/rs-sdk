import { describe, expect, test } from 'bun:test';
import { BotSDK } from '../index';
import { BotActions } from '../actions';

function harness() {
    const sdk = new BotSDK({ botUsername: 'test', password: 'test', autoLaunchBrowser: false });
    const internal = sdk as any;
    let tick = 1;
    const player = { name: 'test', worldX: 3200, worldZ: 3200, x: 128, z: 128, level: 0, animId: -1, combat: { inCombat: false } };
    const snapshot = () => ({
        inGame: true, tick, player: { ...player, combat: { ...player.combat } },
        inventory: [], skills: [], gameMessages: [], nearbyLocs: [], nearbyNpcs: [], nearbyPlayers: [], groundItems: [],
        dialog: { isOpen: false }, interface: { isOpen: false }, bank: { isOpen: false }, shop: { isOpen: false },
    });
    internal.state = snapshot();
    const step = (change: Partial<typeof player> & { inCombat?: boolean } = {}) => {
        const { inCombat, ...rest } = change;
        Object.assign(player, rest);
        if (inCombat !== undefined) player.combat.inCombat = inCombat;
        tick++;
        internal.handleMessage(JSON.stringify({ type: 'sdk_state', state: snapshot() }));
    };
    // A second state frame for the same tick, as the gateway can send.
    const repeat = () => internal.handleMessage(JSON.stringify({ type: 'sdk_state', state: snapshot() }));
    return { bot: new BotActions(sdk), step, repeat };
}

async function settled(promise: Promise<unknown>): Promise<boolean> {
    let done = false;
    promise.then(() => { done = true; }, () => { done = true; });
    await Bun.sleep(5);
    return done;
}

describe('waitForIdle', () => {
    test('waits while walking and resolves after the player stands still', async () => {
        const h = harness();
        const idle = h.bot.waitForIdle(1000);
        h.step({ worldX: 3201 });
        h.step({ worldX: 3202 });
        h.step();
        expect(await settled(idle)).toBeFalse();
        h.step();
        await idle;
    });

    test('keeps waiting through a fight, not just until the player stops walking', async () => {
        const h = harness();
        const idle = h.bot.waitForIdle(1000);
        h.step({ inCombat: true, animId: 422 });
        h.step({ inCombat: true, animId: -1 });
        h.step({ inCombat: true });
        h.step({ inCombat: true });
        expect(await settled(idle)).toBeFalse();
        h.step({ inCombat: false });
        h.step();
        await idle;
    });

    test('ignores repeated states from the same tick', async () => {
        const h = harness();
        const idle = h.bot.waitForIdle(1000, 3);
        h.step();
        h.repeat();
        h.repeat();
        h.step();
        h.repeat();
        expect(await settled(idle)).toBeFalse();
        h.step();
        await idle;
    });

    test('times out with a message that says why', async () => {
        const h = harness();
        const idle = h.bot.waitForIdle(30);
        h.step({ inCombat: true });
        await expect(idle).rejects.toThrow('waitForIdle timed out after 30ms: the player is still moving, animating or in combat');
    });
});
