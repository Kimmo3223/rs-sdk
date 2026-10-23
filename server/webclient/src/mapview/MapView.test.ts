import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import '../lite/dom-shim.js';
import Pix2D from '#/graphics/Pix2D.js';
import { MapView } from './MapView.js';

const GROUND = 0x336699;
const LANDMARK = 0xffcc00;
let flags: boolean[];

beforeEach(() => {
    flags = [MapView.shouldDrawHistory, MapView.shouldDrawPlayers, MapView.shouldDrawLabels,
        MapView.shouldDrawFreemap, MapView.shouldDrawMultimap, MapView.shouldDrawItems, MapView.shouldDrawNpcs];
    MapView.shouldDrawHistory = MapView.shouldDrawPlayers = MapView.shouldDrawLabels = false;
    MapView.shouldDrawFreemap = MapView.shouldDrawMultimap = MapView.shouldDrawItems = MapView.shouldDrawNpcs = false;
});
afterEach(() => {
    [MapView.shouldDrawHistory, MapView.shouldDrawPlayers, MapView.shouldDrawLabels,
        MapView.shouldDrawFreemap, MapView.shouldDrawMultimap, MapView.shouldDrawItems, MapView.shouldDrawNpcs] = flags;
});

function fixture(width: number, height: number, mapWidth: number, mapHeight: number, zoom: number) {
    const grid = () => Array.from({ length: mapWidth }, () => new Int32Array(mapHeight));
    const ground = grid();
    for (let x = 0; x < mapWidth; x++) {
        ground[x]!.fill(GROUND);
        for (let y = 0; y < mapHeight; y++) {
            if (x >= mapWidth / 2 - 4 && x < mapWidth / 2 + 4 &&
                y >= mapHeight / 2 - 4 && y < mapHeight / 2 + 4) ground[x]![y] = LANDMARK;
        }
    }
    // Avoid starting GameShell's loop: the actual redraw and rasterizer run
    // against a tiny synthetic map, with only peripheral controls stubbed.
    const view = Object.assign(Object.defineProperties(Object.create(MapView.prototype), {
        sWid: { value: width }, sHei: { value: height }
    }), {
        mapWidth, mapHeight, zoom,
        focusX: mapWidth / 2, focusZ: mapHeight / 2,
        redraw: true, redrawTimer: 0, showOverview: false, showKey: false,
        blendedGroundColour: ground, floort2: grid(), floorsr: grid(),
        locWall: grid(), locMapscene: grid(), locMapfunction: grid(),
        freePos: grid(), multiPos: grid(), objPos: grid(), npcPos: grid(),
        mapLabelCount: 0, flashTimer: 0, visibleMapFunctions: [],
        visibleMapFunctionsX: [], visibleMapFunctionsY: [],
        drawStringBox() {}, drawArea: null
    });
    Pix2D.setPixels(new Int32Array(width * height), width, height);
    return view;
}

function landmarkSize(width: number, height: number) {
    const xs: number[] = [], ys: number[] = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (Pix2D.pixels[y * width + x] === LANDMARK) { xs.push(x); ys.push(y); }
    }
    return { width: Math.max(...xs) - Math.min(...xs) + 1, height: Math.max(...ys) - Math.min(...ys) + 1 };
}

describe('map viewport scaling', () => {
    for (const [label, width, height, mapWidth, mapHeight] of [
        ['wide', 120, 48, 60, 100],
        ['tall', 48, 120, 100, 60],
        ['both axes beyond the map', 120, 120, 60, 60]
    ] as const) {
        test(`minimum zoom keeps an 8-tile square square in a ${label} viewport`, async () => {
            const view = fixture(width, height, mapWidth, mapHeight, 1.5);
            await view.mainredraw();
            expect(landmarkSize(width, height)).toEqual({ width: 6, height: 6 });
            expect(Pix2D.pixels[0]).toBe(0); // unused viewport stays black
            expect(Pix2D.pixels[(height / 2) * width + width / 2]).toBe(LANDMARK);
        });
    }

    test('ordinary zoom preserves existing tile scale', async () => {
        const view = fixture(120, 48, 200, 200, 4);
        await view.mainredraw();
        expect(landmarkSize(120, 48)).toEqual({ width: 16, height: 16 });
        expect(Pix2D.pixels[0]).toBe(GROUND);
    });

    test('blank margins do not hide labels that were visible when the map fit', async () => {
        const view = fixture(120, 48, 60, 100, 1.5);
        const labels: unknown[][] = [];
        Object.assign(view, {
            mapLabelCount: 1, mapLabel: ['Landmark'], mapLabelX: [30], mapLabelY: [50],
            mapLabelSize: [0], mapOriginX: 0, mapOriginZ: 0,
            f11: { getHeight: () => 10, getYOffset: () => 0,
                centreString: (...args: unknown[]) => labels.push(args) }
        });
        MapView.shouldDrawLabels = true;
        await view.mainredraw();
        expect(labels).toEqual([['Landmark', 60, 24, 0xffffff, true]]);
    });

    test('player and history layers receive the same uncropped viewport', async () => {
        const view = fixture(120, 48, 60, 100, 1.5);
        const calls: number[][] = [];
        view.drawHistory = (...args: number[]) => calls.push(args);
        view.drawPlayers = (...args: number[]) => calls.push(args);
        MapView.shouldDrawHistory = MapView.shouldDrawPlayers = true;
        await view.mainredraw();
        expect(calls).toEqual([
            [-50, 18, 110, 82, 0, 0, 120, 48],
            [-50, 18, 110, 82, 0, 0, 120, 48]
        ]);
    });

    test('detail and region overlays safely clip tile iteration at every edge', async () => {
        const view = fixture(120, 120, 40, 40, 4);
        MapView.shouldDrawFreemap = MapView.shouldDrawMultimap = MapView.shouldDrawItems = MapView.shouldDrawNpcs = true;
        await view.mainredraw();
        expect(landmarkSize(120, 120)).toEqual({ width: 16, height: 16 });
        expect(Pix2D.pixels[0]).toBe(0);
    });
});

describe('map coordinates', () => {
    function view(width: number, height: number, zoom: number, worldX: number, worldZ: number) {
        const v = Object.assign(Object.defineProperties(Object.create(MapView.prototype), {
            sWid: { value: width }, sHei: { value: height }
        }), { zoom, mapWidth: 30 << 6, mapHeight: 52 << 6, mapOriginX: 28 << 6, mapOriginZ: 41 << 6 }) as MapView;
        // Center the view on a world tile the way drawPlayers places a player there.
        v.focusX = worldX - v.mapOriginX;
        v.focusZ = v.mapOriginZ + v.mapHeight - v.remapZ(worldZ);
        return v;
    }

    test('rawZ undoes remapZ in every band', () => {
        for (const band of MapView.MAP_BANDS) {
            for (const z of [band.from << 6, (band.from << 6) + 17, (band.to << 6) + 63]) {
                const unified = MapView.prototype.remapZ.call({}, z);
                expect(MapView.rawZ(unified)).toBe(z);
            }
        }
        expect(MapView.rawZ(100 << 6)).toBe(-1);
    });

    test('the tile under the view center is the one the view is centered on', () => {
        for (const [x, z] of [[3222, 3218], [3185, 3436], [2951, 3380], [3200, 9600]] as const) {
            const v = view(1280, 720, 4, x, z);
            const spot = v.screenToWorld(640, 360)!;
            expect([spot.x, spot.z]).toEqual([x, z]);
            expect(spot.underground).toBe(z >= 9000);
        }
    });

    test('moving one tile on screen moves one tile in the world', () => {
        const v = view(1280, 720, 4, 3222, 3218);
        // At zoom 4 a tile is 2 px; right is +x, down is -z (south).
        expect(v.screenToWorld(640 + 2, 360)).toMatchObject({ x: 3223, z: 3218 });
        expect(v.screenToWorld(640, 360 + 2)).toMatchObject({ x: 3222, z: 3217 });
    });

    test('nothing off the map', () => {
        const v = view(1280, 720, 4, 3222, 3218);
        v.focusX = -5000;
        expect(v.screenToWorld(640, 360)).toBeNull();
    });
});
